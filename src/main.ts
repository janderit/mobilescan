/** Entry point: mounts the app shell (see app.ts). */

import './styles.css';
import { App } from './app';

const root = document.getElementById('app');
if (!root) {
  throw new Error('#app missing');
}
new App(root, { version: __APP_VERSION__, build: __APP_BUILD__ });
