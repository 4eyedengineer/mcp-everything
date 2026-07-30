import { PipelineStatusService } from './pipeline-status.service';

describe('PipelineStatusService', () => {
  let service: PipelineStatusService;

  beforeEach(() => {
    service = new PipelineStatusService();
  });

  it('reports a conversation as not executing before anything happens', () => {
    expect(service.isExecuting('conv-1')).toBe(false);
  });

  it('reports executing after markExecuting', () => {
    service.markExecuting('conv-1');
    expect(service.isExecuting('conv-1')).toBe(true);
  });

  it('reports idle again after markIdle', () => {
    service.markExecuting('conv-1');
    service.markIdle('conv-1');
    expect(service.isExecuting('conv-1')).toBe(false);
  });

  it('tracks multiple conversations independently', () => {
    service.markExecuting('conv-1');
    expect(service.isExecuting('conv-1')).toBe(true);
    expect(service.isExecuting('conv-2')).toBe(false);

    service.markExecuting('conv-2');
    service.markIdle('conv-1');

    expect(service.isExecuting('conv-1')).toBe(false);
    expect(service.isExecuting('conv-2')).toBe(true);
  });

  it('markIdle on a conversation that was never marked executing is a no-op', () => {
    expect(() => service.markIdle('unknown')).not.toThrow();
    expect(service.isExecuting('unknown')).toBe(false);
  });
});
