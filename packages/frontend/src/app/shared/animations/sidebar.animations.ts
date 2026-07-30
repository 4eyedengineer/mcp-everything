import { trigger, state, style, transition, animate } from '@angular/animations';

// prefers-reduced-motion: the Angular animations engine driving slideIn/
// fadeIn below has no built-in awareness of that media query, so it's
// gated externally rather than in this file - AppComponent tracks
// matchMedia('(prefers-reduced-motion: reduce)') in a signal and binds
// `[@.disabled]` on <mcp-conversation-sidebar> (app.component.html). That
// special binding disables trigger-based animations for the bound element
// and everything inside it, which reaches both triggers below without this
// file (or ConversationSidebarComponent) needing reduced-motion logic of
// its own.
export const sidebarAnimations = [
  trigger('slideIn', [
    state('void', style({
      transform: 'translateX(-100%)'
    })),
    state('*', style({
      transform: 'translateX(0)'
    })),
    transition('void => *', [
      animate('300ms cubic-bezier(0.4, 0, 0.2, 1)')
    ]),
    transition('* => void', [
      animate('300ms cubic-bezier(0.4, 0, 0.2, 1)')
    ])
  ]),

  trigger('fadeIn', [
    state('void', style({
      opacity: 0
    })),
    state('*', style({
      opacity: 1
    })),
    transition('void => *', [
      animate('200ms ease-in')
    ]),
    transition('* => void', [
      animate('200ms ease-out')
    ])
  ])
];
