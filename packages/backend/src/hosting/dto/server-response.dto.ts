export class ServerResponseDto {
  id: string;
  serverId: string;
  serverName: string;
  description?: string;
  endpointUrl: string;
  status: string;
  statusMessage?: string;
  tools: Array<{ name: string; description: string; inputSchema: any }>;
  requestCount: number;
  lastRequestAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  deployedAt?: Date;
}
