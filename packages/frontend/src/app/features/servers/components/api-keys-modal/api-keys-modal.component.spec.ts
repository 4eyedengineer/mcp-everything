import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { ApiKeysModalComponent } from './api-keys-modal.component';
import { HostedServer, HostedServerApiKey } from '../../../../core/services/hosting-api.service';
import { API_BASE } from '../../../../core/config/api.config';

/**
 * Covers the API key management modal, with special attention to the
 * one-time secret reveal: the plaintext key must only ever live in
 * `justCreated`, and `acknowledgeAndDismiss()` must be the only way to clear
 * it - and must refuse to do so until the user has ticked the acknowledgement
 * checkbox.
 */
describe('ApiKeysModalComponent', () => {
  const server: HostedServer = {
    id: 'row-1',
    serverId: 'my-server-abc123',
    serverName: 'My Test Server',
    endpointUrl: 'https://example.test/api/hosting/servers/my-server-abc123/mcp',
    status: 'running',
    tools: [],
    requestCount: 0,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01')
  };

  const keysUrl = `${API_BASE}/hosting/servers/${server.serverId}/keys`;

  function makeKey(overrides: Partial<HostedServerApiKey> = {}): HostedServerApiKey {
    return {
      id: 'key-1',
      label: 'ci-runner',
      keyPrefix: 'mcps_A1b2c3',
      lastFour: 'wxyz',
      createdAt: new Date('2026-01-01'),
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
      active: true,
      ...overrides
    };
  }

  async function createComponent() {
    await TestBed.configureTestingModule({
      imports: [ApiKeysModalComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()]
    }).compileComponents();

    const fixture = TestBed.createComponent(ApiKeysModalComponent);
    fixture.componentInstance.server = server;
    const httpMock = TestBed.inject(HttpTestingController);
    fixture.detectChanges(); // triggers ngOnInit -> loadKeys()

    const req = httpMock.expectOne(keysUrl);
    expect(req.request.method).toBe('GET');
    req.flush({ apiKeys: [] });
    fixture.detectChanges();

    return { fixture, component: fixture.componentInstance, httpMock };
  }

  afterEach(() => {
    const httpMock = TestBed.inject(HttpTestingController);
    httpMock.verify();
  });

  it('loads key metadata on init', async () => {
    const { component } = await createComponent();
    expect(component.loading()).toBe(false);
    expect(component.keys()).toEqual([]);
  });

  it('shows the one-time secret after a successful create, and reloads the list', async () => {
    const { component, httpMock } = await createComponent();

    component.newLabel.set('laptop');
    component.submitCreate();

    const createReq = httpMock.expectOne(keysUrl);
    expect(createReq.request.method).toBe('POST');
    expect(createReq.request.body).toEqual({ label: 'laptop' });
    createReq.flush({
      key: 'mcps_realplaintextkeyvalue',
      apiKey: makeKey(),
      warning: { shownOnce: 'once', usage: 'usage' }
    });

    // create() triggers a reload of the list in the background
    const reloadReq = httpMock.expectOne(keysUrl);
    reloadReq.flush({ apiKeys: [makeKey()] });

    expect(component.showingSecret()).toBe(true);
    expect(component.justCreated()?.key).toBe('mcps_realplaintextkeyvalue');
    expect(component.isCreating()).toBe(false);
  });

  it('refuses to dismiss the secret until the acknowledgement checkbox is checked', async () => {
    const { component, httpMock } = await createComponent();

    component.newLabel.set('laptop');
    component.submitCreate();
    httpMock.expectOne(keysUrl).flush({
      key: 'mcps_realplaintextkeyvalue',
      apiKey: makeKey(),
      warning: { shownOnce: 'once', usage: 'usage' }
    });
    httpMock.expectOne(keysUrl).flush({ apiKeys: [makeKey()] });

    expect(component.showingSecret()).toBe(true);

    // Not acknowledged yet - dismissal must be a no-op.
    component.acknowledgeAndDismiss();
    expect(component.showingSecret()).toBe(true);
    expect(component.justCreated()?.key).toBe('mcps_realplaintextkeyvalue');

    // Acknowledge, then dismiss - the plaintext must be gone from state.
    component.acknowledged.set(true);
    component.acknowledgeAndDismiss();

    expect(component.showingSecret()).toBe(false);
    expect(component.justCreated()).toBeNull();
    expect(component.acknowledged()).toBe(false);
  });

  it('ignores backdrop clicks and Escape while the secret is showing', async () => {
    const { component, httpMock } = await createComponent();

    component.newLabel.set('laptop');
    component.submitCreate();
    httpMock.expectOne(keysUrl).flush({
      key: 'mcps_realplaintextkeyvalue',
      apiKey: makeKey(),
      warning: { shownOnce: 'once', usage: 'usage' }
    });
    httpMock.expectOne(keysUrl).flush({ apiKeys: [makeKey()] });

    const closeSpy = spyOn(component.close, 'emit');

    const overlay = document.createElement('div');
    overlay.classList.add('modal-overlay');
    component.onOverlayClick({ target: overlay } as unknown as MouseEvent);
    component.onEscape();
    component.onClose();

    expect(closeSpy).not.toHaveBeenCalled();

    // Once dismissed properly, closing works again.
    component.acknowledged.set(true);
    component.acknowledgeAndDismiss();
    component.onClose();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('surfaces the 5-active-key cap before the user hits it', async () => {
    const { component, httpMock } = await createComponent();

    // Reload with 5 active keys already
    const fiveActive = Array.from({ length: 5 }, (_, i) => makeKey({ id: `key-${i}` }));
    component.loadKeys();
    httpMock.expectOne(keysUrl).flush({ apiKeys: fiveActive });

    expect(component.activeCount()).toBe(5);
    expect(component.atCap()).toBe(true);

    component.startCreating();
    expect(component.isCreating()).toBe(false); // startCreating() must refuse at cap
  });

  it('requests confirmation before revoking, and calls DELETE only on confirm', async () => {
    const { component, httpMock } = await createComponent();

    const key = makeKey();
    component.loadKeys();
    httpMock.expectOne(keysUrl).flush({ apiKeys: [key] });

    component.requestRevoke(key);
    expect(component.revokeTarget()).toEqual(key);

    component.confirmRevoke();
    const deleteReq = httpMock.expectOne(`${keysUrl}/${key.id}`);
    expect(deleteReq.request.method).toBe('DELETE');
    deleteReq.flush({ success: true, apiKey: { ...key, active: false, revokedAt: new Date() } });

    const reloadReq = httpMock.expectOne(keysUrl);
    reloadReq.flush({ apiKeys: [{ ...key, active: false, revokedAt: new Date() }] });

    expect(component.revokeTarget()).toBeNull();
  });
});
