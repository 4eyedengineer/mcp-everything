import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { Subscription } from '../database/entities/subscription.entity';
import { StripeService } from './stripe.service';
import { SubscriptionService } from './subscription.service';
import { SubscriptionController } from './subscription.controller';
import { StripeWebhookController } from './stripe-webhook.controller';
import { UserModule } from '../user/user.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Subscription]),
    ConfigModule,
    UserModule,
  ],
  controllers: [SubscriptionController, StripeWebhookController],
  providers: [StripeService, SubscriptionService],
  exports: [StripeService, SubscriptionService],
})
export class SubscriptionModule {}
