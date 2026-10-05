import React from 'react';
import {createRoot} from 'react-dom/client';
import {App} from './App';
import './style.css';

class ErrorBoundary extends React.Component<{children:React.ReactNode},{failed:boolean}> {
  state={failed:false};
  static getDerivedStateFromError(){return {failed:true};}
  render(){return this.state.failed?<main className="welcome"><h1>Something interrupted the app.</h1><p>Reload to reopen Pact. You can check an unfinished expense save after reloading.</p><button onClick={()=>location.reload()}>Reload</button></main>:this.props.children;}
}
createRoot(document.getElementById('root')!).render(<ErrorBoundary><App/></ErrorBoundary>);
