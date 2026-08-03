import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { LandingComponent } from './landing.component';

describe('LandingComponent', () => {
  let fixture: ComponentFixture<LandingComponent>;
  let text: string;
  let html: string;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [LandingComponent],
      providers: [provideRouter([])],
    }).compileComponents();

    fixture = TestBed.createComponent(LandingComponent);
    fixture.detectChanges();
    text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    html = (fixture.nativeElement as HTMLElement).innerHTML;
  });

  it('renders', () => {
    expect(fixture.componentInstance).toBeTruthy();
  });

  describe('document structure', () => {
    it('has exactly one h1', () => {
      const h1s = (fixture.nativeElement as HTMLElement).querySelectorAll('h1');
      expect(h1s.length).toBe(1);
    });

    it('does not skip from h1 straight past h2', () => {
      const headings = Array.from(
        (fixture.nativeElement as HTMLElement).querySelectorAll('h1, h2, h3'),
      ).map(h => Number(h.tagName.substring(1)));

      expect(headings[0]).toBe(1);
      headings.slice(1).forEach((level, i) => {
        // A heading may only ever go one level deeper than the one before it.
        expect(level).toBeLessThanOrEqual(headings[i] + 1);
      });
    });

    it('gives every image an alt attribute', () => {
      const images = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('img'));
      expect(images.length).toBeGreaterThan(0);
      images.forEach(img => expect(img.hasAttribute('alt')).toBe(true));
    });

    it('offers both sign-in and sign-up routes without being a login page', () => {
      expect(html).toContain('/auth/login');
      expect(html).toContain('/auth/register');
      // A marketing page, not a login form.
      expect((fixture.nativeElement as HTMLElement).querySelectorAll('input').length).toBe(0);
    });

    it('uses the canonical button classes rather than bespoke ones', () => {
      const el = fixture.nativeElement as HTMLElement;
      expect(el.querySelectorAll('.mcp-btn-primary').length).toBeGreaterThan(0);
      expect(el.querySelectorAll('.mcp-btn-secondary').length).toBeGreaterThan(0);
    });
  });

  /**
   * The landing copy exists twice: here, and as the static crawlable shell
   * inside <mcp-root> in src/index.html (the app has no SSR, so a non-JS
   * crawler only ever sees that shell). These assertions pin the factual
   * claims that must not drift between the two. If you change a fact here,
   * change it in src/index.html and src/seo/llms.txt as well.
   */
  describe('load-bearing factual claims (mirrored in index.html and llms.txt)', () => {
    it('states the MCP endpoint, transport and credential correctly', () => {
      expect(text).toContain('POST /mcp');
      expect(text).toContain('Streamable HTTP');
      expect(text).toContain('mcpe_');
      expect(text).toContain('X-API-Key');
      expect(text).toContain('Authorization: Bearer');
    });

    it('lists exactly the six tools the MCP server registers', () => {
      // Mirrors backend mcp-tools.service.ts registerTools().
      [
        'generate_mcp_server',
        'continue_generation',
        'get_generation_status',
        'get_generated_server',
        'list_conversations',
        'search_marketplace',
      ].forEach(tool => expect(text).toContain(tool));
    });

    it('names the four supported inputs', () => {
      expect(text).toContain('GitHub repository');
      expect(text).toContain('documentation');
      expect(text).toContain('service name');
      expect(text).toContain('description');
    });

    it('describes the Docker-sandboxed validation loop', () => {
      expect(text).toContain('Docker');
      expect(text).toContain('JSON-RPC');
      expect(text).toContain('five');
    });
  });

  /**
   * The honesty guard. This project has previously shipped UI describing
   * features that did not exist (a "$3/mo" hosting flow with no billing
   * behind it, and a fabricated endpoint URL). These assertions fail the
   * build if the landing page starts making those claims again.
   */
  describe('honesty guard', () => {
    it('quotes no price, because billing is not implemented', () => {
      expect(text).not.toMatch(/\$\s?\d/);
      expect(text.toLowerCase()).not.toContain('per month for');
      expect(text.toLowerCase()).not.toContain('subscribe');
      expect(text.toLowerCase()).not.toContain('upgrade to pro');
    });

    it('does not claim OpenAPI or GraphQL specification input', () => {
      // No OpenAPI or GraphQL parser exists anywhere in the backend, so the
      // words may appear only as an explicit denial - which must stay on the
      // page, because the in-product help text still wrongly offers it.
      expect(text).toContain('no specification parser exists');
      expect(text).toContain('There is no OpenAPI or GraphQL parser');

      // ...and never as one of the advertised inputs or capabilities. Checked
      // structurally rather than by phrase-matching, so that the FAQ entry
      // "Can I generate from my OpenAPI specification?" - a question whose
      // answer is "no" - doesn't trip the guard.
      const promoted = Array.from(
        (fixture.nativeElement as HTMLElement).querySelectorAll(
          '.input-card, .feature-card, .hero, .steps',
        ),
      )
        .map(el => el.textContent ?? '')
        .join(' ');

      expect(promoted).not.toContain('OpenAPI');
      expect(promoted).not.toContain('GraphQL');
      expect(promoted).not.toContain('Swagger');
    });

    it('does not advertise cloud hosting as available', () => {
      const lower = text.toLowerCase();
      // These phrases would be present-tense claims about the unexercised
      // Kubernetes path.
      expect(lower).not.toContain('we host');
      expect(lower).not.toContain('deploy to the cloud');
      expect(lower).not.toContain('one-click deploy');
      expect(lower).not.toContain('scale automatically');
    });

    it('keeps an explicit "not available yet" disclosure on the page', () => {
      expect(text).toContain('Not available yet');
      expect(text).toContain('Kubernetes');
      expect(text.toLowerCase()).toContain('nothing is for sale');
    });

    it('does not promise a public MCP endpoint on this domain', () => {
      expect(text).toContain('not yet routed on this domain');
    });

    it('does not offer GitHub repository push as an available destination', () => {
      // tier-config.ts gives the free tier deploymentTypes: ['gist'] and
      // deployment-router.service.ts throws TIER_RESTRICTION for 'repo'.
      // Since no paid tier is purchasable, no real account can push to a repo,
      // so the page must present it as gated rather than as a destination.
      const worksToday =
        (fixture.nativeElement as HTMLElement).querySelector('.status-card-ready')?.textContent ??
        '';

      // ("repository" alone is fine there - it's also a generation *input*.)
      expect(worksToday).not.toContain('GitHub repository');
      expect(worksToday).toContain('Gist');
      expect(text).toContain('gated to a paid tier');
    });
  });
});
