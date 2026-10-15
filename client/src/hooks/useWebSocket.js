import { useEffect, useRef, useState, useCallback } from 'react';

/**
 * Generic React hook that opens a WebSocket to `url` for the lifetime of the
 * component (reconnecting if `url` changes) and exposes:
 *  - isConnected: whether the socket is currently open
 *  - messages:    every JSON message received so far, in order
 *  - sendMessage: JSON-serialises and sends a payload (no-op with a warning
 *                 if the socket isn't open)
 *
 * Note: CodeEditor manages its own socket and does not use this hook.
 */
export function useWebSocket(url) {
  const [messages, setMessages] = useState([]);
  const [isConnected, setIsConnected] = useState(false);
  // Holds the live socket without triggering re-renders when it changes
  const socketRef = useRef(null);

  useEffect(() => {
    // Create WebSocket connection
    const socket = new WebSocket(url);
    socketRef.current = socket;

    socket.onopen = () => {
      console.log('WebSocket connected');
      setIsConnected(true);
    };

    // Parse each incoming JSON message and append it to the history
    socket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      setMessages((prev) => [...prev, data]);
    };

    socket.onclose = () => {
      console.log('WebSocket disconnected');
      setIsConnected(false);
    };

    socket.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    // Cleanup: close the socket on unmount or when the url changes
    return () => {
      socket.close();
    };
  }, [url]);

  // Stable function identity so consumers can safely use it in effects
  const sendMessage = useCallback((data) => {
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(data));
    } else {
      console.warn('WebSocket is not connected.');
    }
  }, []);

  return { isConnected, messages, sendMessage };
}
