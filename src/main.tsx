import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { ErrorBoundary } from './shell/ErrorBoundary';

ReactDOM.createRoot(document.getElementById('root')!).render(<ErrorBoundary level="app"><App /></ErrorBoundary>);
