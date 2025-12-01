import { trigger, state, style, transition, animate } from '@angular/animations';

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
