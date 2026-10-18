import { Link } from '../router.jsx';
import './LandingPage.css';

// Signed-in home page: what the platform does and where to start.
export default function LandingPage() {
  return (
    <main className="landing page-enter">
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
            <p>Build solutions together in a shared Python editor.</p>
          </div>
          <div className="feature-card">
            <h3>🎯 Problem Statements</h3>
            <p>See the challenges once your group&apos;s event starts.</p>
          </div>
        </div>

        <div className="landing-actions">
          <Link className="btn-primary landing-submit" to="/dashboard">
            Go to your groups
          </Link>
          <Link className="btn-secondary" to="/coding">
            Open the editor
          </Link>
        </div>
      </div>
    </main>
  );
}
