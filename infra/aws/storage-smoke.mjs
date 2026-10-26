// Run as a one-shot ECS task with the coordinator's task role, no signing keys.
// Uses only a synthetic public fixture; never creates a ceremony or participant.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { AwsS3ArtifactClient } from '@moss/phase2-storage';
const require = createRequire(import.meta.resolve('@moss/phase2-storage'));
const { S3Client, PutObjectCommand, AbortMultipartUploadCommand } = require('@aws-sdk/client-s3');
const { S3_QUARANTINE_BUCKET: quarantineBucket, S3_ARCHIVE_BUCKET: archiveBucket,
  S3_RETENTION_UNTIL: retentionUntil, WEB_ORIGIN: origin } = process.env;
let client, upload;
try {
  if (!quarantineBucket || !archiveBucket || !retentionUntil || !origin) throw new Error('configuration');
  client = new S3Client({ region: process.env.AWS_REGION, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
  const adapter = new AwsS3ArtifactClient(client, { quarantineBucket, archiveBucket, retentionUntil, maxArtifactByteLength: 10 * 1024 ** 2 });
  await adapter.assertConfiguration();
  const bytes = Buffer.alloc(6 * 1024 ** 2, 0x42);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const key = `quarantine/provider-smoke/${Date.now()}`;
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  upload = { bucket: quarantineBucket, key, ...(await adapter.createMultipartUpload({ bucket: quarantineBucket, key, expiresAt, maxByteLength: bytes.length })) };
  const signed = await adapter.signedUploadPartUrls({ ...upload, partNumbers: [1, 2], expiresAt });
  const parts = [];
  for (let i = 0; i < 2; i++) {
    const body = i === 0 ? bytes.subarray(0, 5 * 1024 ** 2) : bytes.subarray(5 * 1024 ** 2);
    // Repeat a part to exercise retry after an ambiguous upload response.
    for (let retry = 0; retry < (i === 0 ? 2 : 1); retry++) {
      const response = await fetch(signed[i].url, { method: 'PUT', body, headers: { Origin: origin } });
      if (!response.ok || response.headers.get('access-control-allow-origin') !== origin) throw new Error('upload cors');
      if (retry === (i === 0 ? 1 : 0)) parts.push({ partNumber: i + 1, etag: response.headers.get('etag') });
    }
  }
  const completed = await adapter.completeMultipartUpload({ ...upload, parts });
  const source = await adapter.headVersion({ bucket: quarantineBucket, key, versionId: completed.versionId });
  if (source?.checksumSha256 !== sha256) throw new Error('source hash');
  const destinationKey = `canonical/provider-smoke/sha256/${sha256}.zkey`;
  const promotion = { sourceBucket: quarantineBucket, sourceKey: key, sourceVersionId: completed.versionId, destinationBucket: archiveBucket, destinationKey, sha256 };
  const first = await adapter.copyImmutable(promotion);
  const retry = await adapter.copyImmutable(promotion);
  if (first.versionId !== retry.versionId) throw new Error('promotion retry');
  // A new adapter represents process restart: re-hash and recover exact version.
  const restarted = new AwsS3ArtifactClient(client, { quarantineBucket, archiveBucket, retentionUntil, maxArtifactByteLength: 10 * 1024 ** 2 });
  const recovered = await restarted.copyImmutable(promotion);
  if (recovered.versionId !== first.versionId) throw new Error('restart recovery');
  const url = await adapter.signedDownloadUrl({ bucket: archiveBucket, key: destinationKey, versionId: first.versionId, expiresInSeconds: 60 });
  const download = await fetch(url, { headers: { Origin: origin, Range: 'bytes=0-1023' } });
  if (download.status !== 206 || download.headers.get('access-control-allow-origin') !== origin || (await download.arrayBuffer()).byteLength !== 1024) throw new Error('download cors');
  let denied = false;
  try { await client.send(new PutObjectCommand({ Bucket: archiveBucket, Key: destinationKey, Body: Buffer.from('invalid overwrite') })); }
  catch (error) { denied = error?.$metadata?.httpStatusCode === 403; }
  if (!denied) throw new Error('overwrite policy');
  console.log('PASS: scoped IAM, multipart retry, exact SHA-256, compliance retention, conditional promotion, restart recovery, browser upload/download CORS, overwrite denial.');
} catch {
  console.error('FAIL: provider storage smoke check. No capabilities or private diagnostics logged.');
  process.exitCode = 1;
} finally {
  if (client && upload) await client.send(new AbortMultipartUploadCommand({ Bucket: upload.bucket, Key: upload.key, UploadId: upload.uploadId })).catch(() => {});
  client?.destroy();
}
