import { Controller, Post, Body, Headers } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AuthService } from '../../services/auth.service';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  async login(@Body() credentials: { username: string; password: string }) {
    return this.authService.login(credentials);
  }

  @Post('verify')
  async verify(@Headers('authorization') authorization: string) {
    const token = authorization?.replace('Bearer ', '') || '';
    return this.authService.verify(token);
  }

  @Post('logout')
  async logout(@Headers('authorization') authorization: string) {
    const token = authorization?.replace('Bearer ', '') || '';
    return this.authService.logout(token);
  }
}
