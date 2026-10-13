"use client";

import { useState, useEffect, useRef } from "react";
import { io, Socket } from "socket.io-client";

export default function KaylaChat() {
  const [username, setUsername] = useState("");
  const [loggedIn, setLoggedIn] = useState(false);
  const [messages, setMessages] = useState<any[]>([]);
  const [input, setInput] = useState("");
  const [partnerOnline, setPartnerOnline] = useState(false);
  const [partnerTyping, setPartnerTyping] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const typingTimeoutRef = useRef<any>(null);

  // Determine who I am and who the partner is
  const myName = username.toLowerCase().trim();
  const isKayla = myName === "kayla";
  // Kayla = boy, yobby = girl
  // boy.png on girl's side, girl.png on boy's side
  const partnerImage = isKayla ? "/girl.png" : "/boy.png";
  const myAvatar = isKayla ? "👨" : "👩";
  const partnerName = isKayla ? "Yobby 💕" : "Kayla 💕";
  const partnerAvatar = isKayla ? "👩" : "👨";

  useEffect(() => {
    if (!loggedIn) return;

    const socket = io("/?XTransformPort=3003");
    socketRef.current = socket;

    socket.on("connect", () => {
      socket.emit("login", myName);
    });

    socket.on("messages", (msgs: any[]) => {
      setMessages(msgs);
      scrollToBottom();
    });

    socket.on("new-message", (msg: any) => {
      setMessages((prev) => [...prev, msg]);
      scrollToBottom();
    });

    socket.on("partner-online", () => setPartnerOnline(true));
    socket.on("partner-offline", () => setPartnerOnline(false));

    socket.on("partner-typing", (data: { sender: string; isTyping: boolean }) => {
      if (data.sender !== myName) {
        setPartnerTyping(data.isTyping);
      }
    });

    socket.on("auth-error", (err: string) => {
      alert(err);
      setLoggedIn(false);
    });

    return () => {
      socket.disconnect();
    };
  }, [loggedIn, myName]);

  const scrollToBottom = () => {
    setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, 100);
  };

  const handleLogin = () => {
    const name = username.trim().toLowerCase();
    if (name === "kayla" || name === "yobby") {
      setLoggedIn(true);
    } else {
      alert("Invalid username. Use 'Kayla' or 'Yobby'.");
    }
  };

  const handleSend = () => {
    if (!input.trim() || !socketRef.current) return;
    const msg = {
      text: input.trim(),
      sender: myName,
      time: new Date().toISOString(),
    };
    socketRef.current.emit("send-message", msg);
    setInput("");
    setIsTyping(false);
    socketRef.current.emit("typing", { sender: myName, isTyping: false });
  };

  const handleTyping = (value: string) => {
    setInput(value);
    if (!socketRef.current) return;
    if (!isTyping && value.length > 0) {
      setIsTyping(true);
      socketRef.current.emit("typing", { sender: myName, isTyping: true });
    }
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    if (value.length === 0) {
      setIsTyping(false);
      socketRef.current.emit("typing", { sender: myName, isTyping: false });
    } else {
      typingTimeoutRef.current = setTimeout(() => {
        setIsTyping(false);
        socketRef.current?.emit("typing", { sender: myName, isTyping: false });
      }, 2000);
    }
  };

  const formatTime = (iso: string) => {
    try {
      return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch {
      return "";
    }
  };

  // === LOGIN SCREEN ===
  if (!loggedIn) {
    return (
      <div className="min-h-screen flex items-center justify-center"
        style={{
          background: "linear-gradient(135deg, #1a0a1e 0%, #2d1b3d 30%, #1a0a2e 60%, #0a0a1e 100%)",
        }}>
        {/* Floating hearts */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          {[...Array(12)].map((_, i) => (
            <div
              key={i}
              className="absolute text-pink-400/20 animate-pulse"
              style={{
                left: `${(i * 8.3) % 100}%`,
                top: `${(i * 12) % 100}%`,
                fontSize: `${20 + (i % 4) * 10}px`,
                animationDelay: `${i * 0.3}s`,
                animationDuration: `${2 + (i % 3)}s`,
              }}
            >
              💕
            </div>
          ))}
        </div>

        <div className="relative z-10 bg-white/5 backdrop-blur-2xl rounded-3xl p-8 sm:p-12 border border-pink-300/20 shadow-2xl max-w-md w-full mx-4">
          <div className="text-center mb-8">
            <div className="text-6xl mb-3">💕</div>
            <h1 className="text-4xl font-bold bg-gradient-to-r from-pink-300 via-rose-300 to-pink-200 bg-clip-text text-transparent">
              Kayla
            </h1>
            <p className="text-pink-200/60 text-sm mt-2 tracking-wider">
              Private Chat · Just Us Two
            </p>
          </div>

          <div className="space-y-4">
            <div>
              <label className="text-pink-200/80 text-xs uppercase tracking-widest mb-2 block">
                Username
              </label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleLogin()}
                placeholder="Enter Kayla or Yobby"
                className="w-full bg-white/10 border border-pink-300/30 rounded-2xl px-5 py-4 text-white placeholder-pink-200/30 focus:outline-none focus:border-pink-400/60 focus:bg-white/15 transition-all text-lg"
              />
            </div>

            <button
              onClick={handleLogin}
              className="w-full bg-gradient-to-r from-pink-500 via-rose-500 to-pink-400 hover:from-pink-400 hover:to-rose-400 text-white font-semibold py-4 rounded-2xl transition-all shadow-lg shadow-pink-500/30 hover:shadow-pink-500/50 text-lg"
            >
              Enter Chat 💕
            </button>
          </div>

          <p className="text-center text-pink-200/40 text-xs mt-6">
            Use <span className="text-pink-300 font-semibold">Kayla</span> or <span className="text-pink-300 font-semibold">Yobby</span> to login
          </p>
        </div>
      </div>
    );
  }

  // === CHAT SCREEN ===
  return (
    <div className="min-h-screen flex flex-col"
      style={{
        background: `linear-gradient(135deg, #1a0a1e 0%, #2d1b3d 30%, #1a0a2e 60%, #0a0a1e 100%)`,
      }}>
      {/* Header */}
      <header className="sticky top-0 z-50 bg-gradient-to-r from-pink-600/30 to-rose-600/30 backdrop-blur-xl border-b border-pink-300/20 px-4 py-3 flex items-center gap-3">
        <div className="relative">
          <div className="w-11 h-11 rounded-full bg-gradient-to-br from-pink-400 to-rose-500 flex items-center justify-center text-xl shadow-lg">
            {partnerAvatar}
          </div>
          {partnerOnline && (
            <div className="absolute bottom-0 right-0 w-3 h-3 bg-green-400 rounded-full border-2 border-[#1a0a1e]"></div>
          )}
        </div>
        <div className="flex-1">
          <h2 className="text-white font-semibold text-lg">{partnerName}</h2>
          <p className="text-xs text-white/50">
            {partnerOnline ? "🟢 Online" : "⚪ Last seen recently"}
            {partnerTyping && " · typing..."}
          </p>
        </div>
        <div className="text-2xl">💕</div>
      </header>

      {/* Chat area with background image */}
      <main
        className="flex-1 overflow-y-auto px-4 py-4 space-y-3"
        style={{
          backgroundImage: `linear-gradient(135deg, rgba(26, 10, 30, 0.85), rgba(45, 27, 61, 0.85)), url(${partnerImage})`,
          backgroundSize: "cover",
          backgroundPosition: "center",
          backgroundAttachment: "fixed",
        }}
      >
        {/* Day separator */}
        <div className="flex justify-center my-4">
          <div className="bg-pink-500/20 backdrop-blur-md text-pink-200 text-xs px-4 py-1.5 rounded-full border border-pink-300/20">
            💕 Private Chat
          </div>
        </div>

        {/* Messages */}
        {messages.map((msg, i) => {
          const isMe = msg.sender === myName;
          return (
            <div key={msg.id || i} className={`flex ${isMe ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[75%] sm:max-w-[60%] px-4 py-2.5 rounded-2xl backdrop-blur-md shadow-lg ${
                  isMe
                    ? "bg-gradient-to-br from-pink-500/80 to-rose-500/80 text-white rounded-br-md"
                    : "bg-white/15 text-white rounded-bl-md border border-white/10"
                }`}
              >
                <p className="text-sm sm:text-base whitespace-pre-wrap break-words">{msg.text}</p>
                <p className={`text-[10px] mt-1 ${isMe ? "text-white/60" : "text-white/40"}`}>
                  {formatTime(msg.time)}
                </p>
              </div>
            </div>
          );
        })}

        {/* Typing indicator */}
        {partnerTyping && (
          <div className="flex justify-start">
            <div className="bg-white/15 backdrop-blur-md px-4 py-3 rounded-2xl rounded-bl-md border border-white/10">
              <div className="flex gap-1">
                <div className="w-2 h-2 bg-pink-300 rounded-full animate-bounce" style={{ animationDelay: "0s" }}></div>
                <div className="w-2 h-2 bg-pink-300 rounded-full animate-bounce" style={{ animationDelay: "0.2s" }}></div>
                <div className="w-2 h-2 bg-pink-300 rounded-full animate-bounce" style={{ animationDelay: "0.4s" }}></div>
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </main>

      {/* Input bar */}
      <footer className="sticky bottom-0 bg-gradient-to-r from-pink-900/40 to-rose-900/40 backdrop-blur-xl border-t border-pink-300/20 p-3">
        <div className="flex items-center gap-2 max-w-3xl mx-auto">
          <input
            type="text"
            value={input}
            onChange={(e) => handleTyping(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSend()}
            placeholder="Type a message..."
            className="flex-1 bg-white/10 backdrop-blur-md border border-pink-300/20 rounded-full px-5 py-3 text-white placeholder-white/40 focus:outline-none focus:border-pink-400/50 transition-all"
          />
          <button
            onClick={handleSend}
            className="bg-gradient-to-r from-pink-500 to-rose-500 hover:from-pink-400 hover:to-rose-400 text-white w-12 h-12 rounded-full flex items-center justify-center shadow-lg shadow-pink-500/30 transition-all hover:scale-105 active:scale-95"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13"></line>
              <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
            </svg>
          </button>
        </div>
        <div className="text-center text-pink-200/30 text-[10px] mt-2">
          Kayla 💕 Made for us
        </div>
      </footer>
    </div>
  );
}
