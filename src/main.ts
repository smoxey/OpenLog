import { mount } from 'svelte';
import { registerSW } from 'virtual:pwa-register';
import './app.css';
import App from './App.svelte';

// Register the service worker for offline / PWA support.
// autoUpdate strategy: new versions are activated on the next visit.
registerSW({ immediate: true });

const app = mount(App, {
  target: document.getElementById('app')!,
});

export default app;
