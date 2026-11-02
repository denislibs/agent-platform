import { render } from 'preact';
import '../../fonts.css';
import '../../styles/index.css';
import './showcase.css';
import { App } from './App.tsx';

render(<App />, document.getElementById('app')!);
