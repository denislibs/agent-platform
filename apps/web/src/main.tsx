import './zod-jitless.ts';
import { render } from 'preact';
import '@agent/ui/fonts.css';
import '@agent/ui/styles.css';
import { App } from './app.tsx';

render(<App />, document.getElementById('app')!);
