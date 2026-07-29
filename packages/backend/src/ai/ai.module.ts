import { Global, Module } from '@nestjs/common';
import { AnthropicService } from './anthropic.service';

/**
 * AI Module
 *
 * Global so every feature module can inject {@link AnthropicService} without
 * re-importing it. This is deliberately the only place an Anthropic client is
 * constructed.
 */
@Global()
@Module({
  providers: [AnthropicService],
  exports: [AnthropicService],
})
export class AiModule {}
