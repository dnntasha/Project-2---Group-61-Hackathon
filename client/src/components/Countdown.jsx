import { useEffect, useRef, useState } from 'react';
import './Countdown.css';

function formatTime(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

//Count down using the server clock
export default function Countdown({ endsAt, serverTime, onEnd }) {
  //Difference between the computer clock and the server clock
  const [offset] = useState(() =>
    serverTime ? new Date(serverTime).getTime() - Date.now() : 0
  );
  const end = new Date(endsAt).getTime();
  const [remaining, setRemaining] = useState(() => end - (Date.now() + offset));

  const onEndRef = useRef(onEnd);
  useEffect(() => {
    onEndRef.current = onEnd;
  }, [onEnd]);

  useEffect(() => {
    const timer = setInterval(() => {
      const left = end - (Date.now() + offset);
      setRemaining(left);
      if (left <= 0) {
        clearInterval(timer);
        onEndRef.current?.();
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [end, offset]);

  if (remaining <= 0) {
    return <p className="countdown countdown-ended">Event ended</p>;
  }

  const urgent = remaining <= 5 * 60 * 1000;
  return (
    <p className={`countdown${urgent ? ' countdown-urgent' : ''}`} role="timer">
      <span className="countdown-label">Time left</span>
      <span className="countdown-value">{formatTime(remaining)}</span>
    </p>
  );
}
