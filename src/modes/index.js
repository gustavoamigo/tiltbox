// The modes, in the order the bar shows them. Each is loaded only when picked, so one broken
// mode cannot stop the others. icon: SVG children for a 24x24 viewBox, filled.
export const MODES = [
  {
    id: 'water', name: 'Water', accent: '#6cc4ff',
    icon: '<path d="M12 2.5c-3.6 5-6.6 8.6-6.6 12.1a6.6 6.6 0 0 0 13.2 0c0-3.5-3-7.1-6.6-12.1z"/>',
    load: () => import('./water.js'),
  },
  {
    id: 'honey', name: 'Honey', accent: '#ffb53a',
    icon: '<path d="M12 2.2l8 4.6v9.2l-8 4.6-8-4.6V6.8z"/>',
    load: () => import('./honey.js'),
  },
  {
    id: 'marbles', name: 'Marbles', accent: '#9ef0c8',
    icon: '<circle cx="7.6" cy="15.6" r="4.9"/><circle cx="16.8" cy="16" r="4.2"/><circle cx="12.6" cy="7.4" r="3.9"/>',
    load: () => import('./marbles.js'),
  },
  {
    id: 'balls', name: 'Balls', accent: '#ff7a95',
    icon: '<circle cx="12" cy="9" r="6.3"/><rect x="4.5" y="18.6" width="15" height="2.6" rx="1.3"/>',
    load: () => import('./balls.js'),
  },
  {
    id: 'sand', name: 'Sand', accent: '#e8c27a',
    icon: '<path d="M6 2.5h12v2.2c0 3-2.5 5.2-4.4 7.3 1.9 2.1 4.4 4.3 4.4 7.3v2.2H6v-2.2c0-3 2.5-5.2 4.4-7.3C8.5 9.9 6 7.7 6 4.7z"/>',
    load: () => import('./sand.js'),
  },
  {
    id: 'snow', name: 'Snow', accent: '#cfe3ff',
    icon: '<rect x="10.9" y="2" width="2.2" height="20" rx="1.1"/><rect x="10.9" y="2" width="2.2" height="20" rx="1.1" transform="rotate(60 12 12)"/><rect x="10.9" y="2" width="2.2" height="20" rx="1.1" transform="rotate(-60 12 12)"/>',
    load: () => import('./snow.js'),
  },
];
