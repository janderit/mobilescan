/** Entry point: mounts the app shell (see app.ts). */

import './styles.css';
import { App } from './app';
import { UpdateService } from './update';

const root = document.getElementById('app');
if (!root) {
  throw new Error('#app missing');
}
const current = { version: __APP_VERSION__, build: __APP_BUILD__ };
const updates = new UpdateService({ current, url: `${import.meta.env.BASE_URL}version.json` });
new App(root, { ...current, updates });
