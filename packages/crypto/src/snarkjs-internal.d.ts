declare module "@cabure/snarkjs-phase2-contribute" {
  export interface SnarkjsContributionLogger {
    debug(message: string): void;
    info(message: string): void;
  }

  export default function phase2Contribute(
    previousZkey: unknown,
    newZkey: unknown,
    name: string,
    entropy: string,
    logger?: SnarkjsContributionLogger,
  ): Promise<Uint8Array>;
}


declare module "@cabure/snarkjs-bellman-contribute" {
  export default function contribute(curve: unknown, previous: unknown, next: unknown, entropy: string,
    logger?: { debug(message: string): void; info(message: string): void }): Promise<Uint8Array>;
}
