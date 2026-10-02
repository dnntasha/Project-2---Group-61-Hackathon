import { useState } from 'react';
import './LoginPage.css';

export default function LandingPage({ onNavigate }) {
  const [busy, setBusy] = useState(false);

  function handleGetStarted() {
    setBusy(true);
    // Simulate navigation or action trigger
    setTimeout(() => {
      setBusy(false);
      if (onNavigate) onNavigate('login');
    }, 300);
  }

  return (
    <main className="landing">
      <div className="landing-panel">
        <p className="landing-brand">The Hackathon</p>
        <h1>Welcome to the Platform</h1>
        <p className="landing-lead">
          Collaborate, code, and solve real-world problems with your team in
          real time.
        </p>

        <div className="landing-features">
          <div className="feature-card">
            <h3>👥 Team Groups</h3>
            <p>Form or join groups with fellow hackers easily.</p>
          </div>
          <div className="feature-card">
            <h3>💻 Live Code Editor</h3>
            <p>Build solutions with browser-based code tools.</p>
          </div>
          <div className="feature-card">
            <h3>🎯 Problem Statements</h3>
            <p>Access challenge details and submit your project.</p>
          </div>
        </div>

        <div className="landing-actions">
          <button
            className="landing-submit"
            onClick={handleGetStarted}
            disabled={busy}
          >
            {busy ? 'Please wait…' : 'Get Started'}
          </button>
        </div>

        <p className="landing-footer">
          Already standard user?{' '}
          <button
            type="button"
            onClick={() => onNavigate && onNavigate('login')}
          >
            Sign in here
          </button>
        </p>
      </div>
    </main>
  );
}
