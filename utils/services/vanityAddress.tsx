// vanityGenerator.ts
import { Keypair } from '@solana/web3.js';

export interface VanityConfig {
  prefix?: string;
  suffix?: string;
  caseInsensitive: boolean;
  maxAttempts?: number;
  threads?: number;
  debug?: boolean;
}

interface WorkerMessage {
  type: 'progress' | 'success';
  data: {
    attempts?: number;
    address?: string;
    privateKey?: Uint8Array;
    rate?: number;
  };
}

/**
 * 1. Longer patterns significantly increase generation time
 * 2. Combined prefix and suffix patterns exponentially increase generation time
 * 
 * how to use:
 * 
 *  const vanityGenerator = new VanityAddressGenerator({
 *    prefix: nameInput,
 *    caseInsensitive: true,
 *    threads: 8,
 *  })
 *  const generatedKeypair = await vanityGenerator.generate()
 * 
 *  // listen to progress callback
 *  // vanityGenerator.setProgressCallback(({ attempts, rate, elapsed }) => {
 *  //   console.log(`Progress: ${attempts.toLocaleString()} attempts, ${rate.toLocaleString()}/sec, ${elapsed / 1000} seconds`);
 *  // });
 *  
 *  // force stop the generator
 *  // vanityGenerator.stop()
 * 
 *  console.log(generatedKeypair.publicKey)
 *  // return the keypair
 *  return generatedKeypair.privateKey
 */
export class VanityAddressGenerator {
  private config: VanityConfig;
  private totalAttempts: number = 0;
  private startTime: number = 0;
  private workers: Worker[] = [];
  private isRunning: boolean = false;

  constructor(config: VanityConfig) {
    this.validateConfig(config);
    this.config = {
      ...config,
      threads: config.threads || navigator.hardwareConcurrency || 4
    };
  }

  private validateConfig(config: VanityConfig): void {
    if (!config.prefix && !config.suffix) {
      throw new Error('At least one pattern (prefix or suffix) must be specified');
    }

    const base58Regex = /^[1-9A-HJ-NP-Za-km-z]+$/;
    
    if (config.prefix && !base58Regex.test(config.prefix)) {
      throw new Error('Prefix contains invalid characters for base58');
    }

    if (config.suffix && !base58Regex.test(config.suffix)) {
      throw new Error('Suffix contains invalid characters for base58');
    }

    const totalLength = (config.prefix?.length || 0) + (config.suffix?.length || 0);
    if (totalLength > 10) {
      console.warn('⚠️ Warning: Combined pattern length > 10 may take excessive time to generate');
    }

    const maxThreads = navigator.hardwareConcurrency || 4;
    if (config.threads && (config.threads < 1 || config.threads > maxThreads * 2)) {
      throw new Error(`Thread count must be between 1 and ${maxThreads * 2}`);
    }
  }

  public async generate(): Promise<{ publicKey: string; privateKey: Keypair; attempts: number; duration: number }> {
    return new Promise((resolve, reject) => {
      this.startTime = Date.now();
      this.isRunning = true;
      this.totalAttempts = 0;
      
      const workerBlob = new Blob([WORKER_CODE], { type: 'application/javascript' });
      const workerUrl = URL.createObjectURL(workerBlob);
      
      console.log(`Starting Vanity Address Generator with ${this.config.threads} workers...`);
      
      let lastProgressUpdate = Date.now();
      const progressInterval = 1000; // Update every second

      const onProgress = (progress: { attempts: number }) => {
        if (!this.isRunning) return;
        
        this.totalAttempts += progress.attempts;
        const now = Date.now();
        
        if (now - lastProgressUpdate >= progressInterval) {
          const elapsed = now - this.startTime;
          const rate = Math.floor(this.totalAttempts / (elapsed / 1000));
          this.onProgress?.({
            attempts: this.totalAttempts,
            rate,
            elapsed
          });
          lastProgressUpdate = now;
        }
      };

      for (let i = 0; i < this.config.threads!; i++) {
        const worker = new Worker(workerUrl);

        worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
          if (!this.isRunning) return;

          if (e.data.type === 'progress') {
            onProgress({ attempts: e.data.data.attempts || 0 });
          } else if (e.data.type === 'success') {
            this.stopWorkers();
            URL.revokeObjectURL(workerUrl);
            
            const duration = Date.now() - this.startTime;
            
            resolve({
              publicKey: e.data.data.address!,
              privateKey: Keypair.fromSecretKey(e.data.data.privateKey!),
              attempts: this.totalAttempts,
              duration
            });
          }
        };

        worker.onerror = (error) => {
          console.error(`Worker ${i} error:`, error);
          this.stopWorkers();
          URL.revokeObjectURL(workerUrl);
          reject(error);
        };

        worker.postMessage({
          config: this.config,
          workerId: i
        });

        this.workers.push(worker);
      }
    });
  }

  private stopWorkers(): void {
    this.isRunning = false;
    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];
  }

  private onProgress?: (progress: { attempts: number; rate: number; elapsed: number }) => void;
  public setProgressCallback(callback: (progress: { attempts: number; rate: number; elapsed: number }) => void) {
    this.onProgress = callback;
  }
}

// This code will be run in the Web Worker context
const WORKER_CODE = `
importScripts('https://unpkg.com/@solana/web3.js@latest/lib/index.iife.min.js');

class VanityWorker {
  constructor(config, workerId) {
    this.config = config;
    this.workerId = workerId;
    this.attempts = 0;
    this.reportInterval = 10000;
  }

  matchesPattern(address) {
    const { prefix, suffix, caseInsensitive } = this.config;
    
    const targetAddress = caseInsensitive ? address.toLowerCase() : address;
    const targetPrefix = caseInsensitive && prefix ? prefix.toLowerCase() : prefix;
    const targetSuffix = caseInsensitive && suffix ? suffix.toLowerCase() : suffix;

    const prefixMatch = !prefix || targetAddress.startsWith(targetPrefix);
    const suffixMatch = !suffix || targetAddress.endsWith(targetSuffix);

    return prefixMatch && suffixMatch;
  }

  generateRandomKeypair() {
    return solanaWeb3.Keypair.generate();
  }

  async search() {
    while (true) {
      for (let i = 0; i < this.reportInterval; i++) {
        const keypair = this.generateRandomKeypair();
        const address = keypair.publicKey.toBase58();

        if (this.matchesPattern(address)) {
          self.postMessage({
            type: 'success',
            data: {
              address,
              privateKey: keypair.secretKey,
              attempts: this.attempts + i + 1
            }
          });
          return;
        }
      }

      this.attempts += this.reportInterval;
      
      self.postMessage({
        type: 'progress',
        data: {
          attempts: this.reportInterval
        }
      });

      if (this.config.maxAttempts && this.attempts >= this.config.maxAttempts) {
        throw new Error(\`Worker \${this.workerId}: Maximum attempts reached\`);
      }
    }
  }
}

self.onmessage = function(e) {
  const { config, workerId } = e.data;
  const worker = new VanityWorker(config, workerId);
  worker.search().catch(error => {
    console.error(\`Worker \${workerId} error:\`, error);
    self.close();
  });
};
`;