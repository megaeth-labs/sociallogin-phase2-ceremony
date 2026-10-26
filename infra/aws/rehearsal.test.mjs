import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const template = JSON.parse(await readFile(new URL('./rehearsal.cloudformation.json', import.meta.url)));
test('closed review is the default and cannot initialize an epoch', () => {
  assert.equal(template.Parameters.ReviewMode.Default, 'true');
  assert.equal(template.Parameters.EnableServices.Default, 'false');
  assert.equal(template.Parameters.InitializeCeremony.Default, 'false');
  assert.ok(template.Rules.NoInitializationInReview);
  assert.equal(template.Resources.VerifierService.Condition, 'RunVerifier');
  assert.deepEqual(template.Resources.CoordinatorTask.Properties.ContainerDefinitions[0].Command['Fn::If'][1], ['review']);
});
test('only managed HTTPS reaches a private ALB and database', () => {
  assert.equal(template.Resources.LoadBalancer.Properties.Scheme, 'internal');
  assert.ok(template.Resources.HTTPSIngress.Properties.SourceSecurityGroupId);
  assert.equal(template.Resources.Database.Properties.PubliclyAccessible, false);
  assert.equal(template.Resources.ApiIntegration.Properties.ConnectionType, 'VPC_LINK');
  assert.equal(template.Resources.ApiIntegration.Properties.RequestParameters['overwrite:path'], '$request.path');
  assert.ok(template.Resources.S3Endpoint);
});
test('archive retention is explicit at launch and budget is project scoped', () => {
  assert.deepEqual(template.Resources.Archive.Properties.ObjectLockConfiguration, { ObjectLockEnabled: 'Enabled' });
  const budget = template.Resources.Budget.Properties;
  assert.deepEqual(budget.Budget.BudgetLimit.Amount, { Ref: 'MonthlyBudgetUsd' });
  assert.deepEqual(budget.Budget.CostFilters, { TagKeyValue: [{ 'Fn::Sub': 'user:Project$${ProjectName}' }] });
  assert.deepEqual(budget.NotificationsWithSubscribers.map((n) => [n.Notification.Threshold, n.Notification.ThresholdType]),
    [[50, 'PERCENTAGE'], [75, 'PERCENTAGE'], [100, 'PERCENTAGE']]);
});

test('defaults keep the existing rehearsal stack unchanged', () => {
  const p = template.Parameters;
  // $100 / $150 / $200 alerts, as before the budget was parameterized.
  assert.equal(p.ProjectName.Default, 'moss-phase2-rehearsal');
  assert.equal(p.MonthlyBudgetUsd.Default, 200);
  assert.equal(p.ApiRateLimit.Default, 50);
  assert.equal(p.ApiBurstLimit.Default, 100);
  assert.equal(p.DatabaseInstanceClass.Default, 'db.t4g.small');
  assert.equal(p.DatabaseMultiAZ.Default, 'false');
  assert.deepEqual(template.Conditions.DatabaseStandby, { 'Fn::Equals': [{ Ref: 'DatabaseMultiAZ' }, 'true'] });
  assert.deepEqual(template.Resources.Database.Properties.MultiAZ, { 'Fn::If': ['DatabaseStandby', true, false] });
  assert.deepEqual(template.Resources.ApiStage.Properties.DefaultRouteSettings,
    { ThrottlingBurstLimit: { Ref: 'ApiBurstLimit' }, ThrottlingRateLimit: { Ref: 'ApiRateLimit' } });
});

test('browser archive reads permit only the rehearsal origin and expose stream lengths', () => {
  const cors = template.Resources.Archive.Properties.CorsConfiguration.CorsRules[0];
  assert.deepEqual(cors.AllowedOrigins, [{ Ref: 'WebOrigin' }]);
  assert.deepEqual(cors.AllowedMethods, ['GET', 'HEAD']);
  assert.ok(cors.ExposedHeaders.includes('Content-Length'));
  assert.deepEqual(template.Resources.ArchiveDelivery.Properties.DistributionConfig.DefaultCacheBehavior.ResponseHeadersPolicyId, { Ref: 'ArchiveCors' });
});
