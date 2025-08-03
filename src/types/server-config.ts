import type { ServerConfig } from './index';

export interface ExpressServerConfig extends ServerConfig {
  readonly expressPort: number;
} 