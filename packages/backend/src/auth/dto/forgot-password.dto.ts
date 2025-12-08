import { IsEmail } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ForgotPasswordDto {
  @ApiProperty({ example: 'user@example.com', description: 'Email address of the account' })
  @IsEmail({}, { message: 'Please provide a valid email address' })
  email: string;
}
