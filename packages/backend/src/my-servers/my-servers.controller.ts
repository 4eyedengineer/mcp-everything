import { Controller, Get } from '@nestjs/common';
import { MyServersService, MyServerEntry } from './my-servers.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../database/entities/user.entity';

// Route protected by the global JWT guard - user is authenticated automatically.
@Controller('api/v1/my-servers')
export class MyServersController {
  constructor(private readonly myServersService: MyServersService) {}

  /**
   * Every server the current user has generated, each tagged with where it
   * sits on the GENERATED -> DEPLOYED -> HOSTED lifecycle ladder.
   *
   * This is what backs the "My Servers" page: previously that page only
   * listed HOSTED servers (via GET /api/hosting/servers), so a user who
   * generated - but never deployed/hosted - a server saw a blank page.
   */
  @Get()
  async getMyServers(@CurrentUser() user: User): Promise<{ servers: MyServerEntry[] }> {
    const servers = await this.myServersService.getMyServers(user.id);
    return { servers };
  }
}
