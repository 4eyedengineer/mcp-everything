export class ServerStatusDto {
  serverId: string;
  status: string;
  message: string;
  replicas: number;
  readyReplicas: number;
  lastUpdated: Date;
}
