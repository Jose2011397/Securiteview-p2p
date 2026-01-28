import React, { useState, useEffect, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import {
  getFirestore,
  doc,
  setDoc,
  onSnapshot,
  collection,
  addDoc,
  updateDoc,
  getDoc
} from 'firebase/firestore';
import {
  getAuth,
  signInAnonymously,
  signInWithCustomToken,
  onAuthStateChanged
} from 'firebase/auth';
import {
  Camera,
  ShieldCheck,
  Video,
  MonitorPlay,
  Plus,
  Minus,
  Mic,
  MicOff,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  RotateCw,
  Headphones,
  Lock,
  CheckCircle2
} from 'lucide-react';

/* ================= CONFIGURAÇÃO ================= */

const firebaseConfig = JSON.parse(__firebase_config);
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const appId = typeof __app_id !== 'undefined' ? __app_id : 'securiteview-p2p';

const rtcConfig = {
  iceServers: [
    { urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] },
    { urls: ['stun:stun.l.google.com:19302'] }
  ]
};

/* ================= COMPONENTE PRINCIPAL ================= */

export default function App() {
  const [user, setUser] = useState(null);
  const [mode, setMode] = useState('permissions'); // Inicia na tela de permissões
  const [roomId, setRoomId] = useState('');
  const [status, setStatus] = useState('Autenticando...');
  const [isStreaming, setIsStreaming] = useState(false);
  
  const [remoteStreams, setRemoteStreams] = useState({}); 
  const [activePeerConfigs, setActivePeerConfigs] = useState({}); 
  const [focusedPeerId, setFocusedPeerId] = useState(null); 
  const [isSimulatedFs, setIsSimulatedFs] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(false); 

  const localStream = useRef(null);
  const peerConnections = useRef({}); 
  const containerRef = useRef(null);
  const cameraId = useRef(crypto.randomUUID());
  
  const remoteAudioRef = useRef(null); 
  const audioContext = useRef(null);

  /* ================= PERMISSIONS HANDLER ================= */
  const requestPermissions = async () => {
    try {
      setStatus("Solicitando permissões...");
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      // Para as tracks imediatamente após conseguir a permissão inicial
      stream.getTracks().forEach(track => track.stop());
      setMode('menu');
      setStatus('Pronto');
    } catch (err) {
      console.error("Permissão negada:", err);
      setStatus("Erro: Permissões de Câmera/Microfone são obrigatórias.");
    }
  };

  /* ================= AUDIO POLICY HELPER ================= */
  const resumeAudioContext = async () => {
    try {
      if (!audioContext.current) {
        audioContext.current = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (audioContext.current.state === 'suspended') {
        await audioContext.current.resume();
      }
      
      const audios = document.querySelectorAll('audio, video');
      for (const el of audios) {
        el.muted = false;
        try {
          await el.play();
        } catch (e) {
          console.log("Play pendente");
        }
      }
      setAudioEnabled(true);
    } catch (e) {
      console.error("Erro ao ativar áudio:", e);
    }
  };

  /* ================= AUTH ================= */

  useEffect(() => {
    const initAuth = async () => {
      try {
        if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
          await signInWithCustomToken(auth, __initial_auth_token);
        } else {
          await signInAnonymously(auth);
        }
      } catch (err) {
        setStatus("Erro de autenticação");
      }
    };
    initAuth();
    
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
    });
    return () => unsubscribe();
  }, []);

  const getPeersCollection = (room) => 
    collection(db, 'artifacts', appId, 'public', 'data', 'rooms', room, 'peers');
  
  const getPeerDoc = (room, pId) => 
    doc(db, 'artifacts', appId, 'public', 'data', 'rooms', room, 'peers', pId);

  /* ================= MODO CÂMERA (TRANSMISSOR) ================= */

  const startCameraMode = async () => {
    if (!roomId || !user) return;
    await resumeAudioContext();
    setStatus("Iniciando espião...");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: { echoCancellation: true, noiseSuppression: true }
      });
      localStream.current = stream;
      setIsStreaming(true);

      const pc = new RTCPeerConnection(rtcConfig);
      peerConnections.current[cameraId.current] = pc;
      
      stream.getTracks().forEach(t => pc.addTrack(t, stream));
      pc.addTransceiver('audio', { direction: 'recvonly' });

      pc.ontrack = (e) => {
        if (e.track.kind === 'audio' && remoteAudioRef.current) {
          remoteAudioRef.current.srcObject = e.streams[0];
          remoteAudioRef.current.muted = false;
          remoteAudioRef.current.play().then(() => setAudioEnabled(true)).catch(err => {
             setAudioEnabled(false);
          });
        }
      };

      const peerDocRef = getPeerDoc(roomId, cameraId.current);
      const offerCandidatesCol = collection(peerDocRef, 'offerCandidates');
      const answerCandidatesCol = collection(peerDocRef, 'answerCandidates');

      pc.onicecandidate = e => {
        if (e.candidate) addDoc(offerCandidatesCol, e.candidate.toJSON());
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      await setDoc(peerDocRef, {
        cameraId: cameraId.current,
        offer: { sdp: offer.sdp, type: offer.type },
        createdBy: user.uid,
        timestamp: Date.now(),
        controls: { zoom: 1, rotation: 0, remoteMic: true, anchorMic: true }
      });

      onSnapshot(peerDocRef, async (snap) => {
        const data = snap.data();
        if (!data || !pc) return;
        if (data.answer && pc.signalingState !== 'stable') {
          await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
        }
        if (data.controls) {
          const { zoom, remoteMic } = data.controls;
          const vTrack = stream.getVideoTracks()[0];
          if (vTrack) {
            const caps = vTrack.getCapabilities?.() || {};
            if (caps.zoom) vTrack.applyConstraints({ advanced: [{ zoom }] }).catch(() => {});
          }
          const aTrack = stream.getAudioTracks()[0];
          if (aTrack) aTrack.enabled = remoteMic;
        }
      });

      onSnapshot(answerCandidatesCol, snap => {
        snap.docChanges().forEach(c => {
          if (c.type === 'added') pc.addIceCandidate(new RTCIceCandidate(c.doc.data())).catch(() => {});
        });
      });

      setStatus("Transmissão Ativa");
    } catch (e) {
      setStatus("Erro de Hardware");
    }
  };

  /* ================= MODO ÂNCORA (MONITOR) ================= */

  const startViewerMode = async () => {
    if (!roomId || !user) return;
    await resumeAudioContext();
    setStatus("Conectando...");
    
    let anchorStream = null;
    try {
      anchorStream = await navigator.mediaDevices.getUserMedia({ 
        audio: { echoCancellation: true, noiseSuppression: true } 
      });
      localStream.current = anchorStream;
    } catch(e) {
      console.warn("Monitor sem microfone.");
    }

    const peersCol = getPeersCollection(roomId);

    onSnapshot(peersCol, snap => {
      snap.docChanges().forEach(async change => {
        if (change.type !== 'added') return;
        const peerId = change.doc.id;
        const peerData = change.doc.data();
        
        if (peerConnections.current[peerId] || !peerData.offer) return;

        const pc = new RTCPeerConnection(rtcConfig);
        peerConnections.current[peerId] = pc;

        if (anchorStream) {
          anchorStream.getTracks().forEach(t => pc.addTrack(t, anchorStream));
        }

        pc.ontrack = e => {
          setRemoteStreams(prev => ({ ...prev, [peerId]: e.streams[0] }));
        };

        const peerDocRef = getPeerDoc(roomId, peerId);
        const offerCandidatesCol = collection(peerDocRef, 'offerCandidates');
        const answerCandidatesCol = collection(peerDocRef, 'answerCandidates');

        pc.onicecandidate = e => {
          if (e.candidate) addDoc(answerCandidatesCol, e.candidate.toJSON());
        };

        await pc.setRemoteDescription(new RTCSessionDescription(peerData.offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        
        await updateDoc(peerDocRef, { answer: { sdp: answer.sdp, type: answer.type } });

        onSnapshot(peerDocRef, s => {
          const d = s.data();
          if (d?.controls) {
            setActivePeerConfigs(prev => ({ ...prev, [peerId]: d.controls }));
            if (anchorStream) {
              anchorStream.getAudioTracks().forEach(t => t.enabled = !!d.controls.anchorMic);
            }
          }
        });

        onSnapshot(offerCandidatesCol, s2 => {
          s2.docChanges().forEach(c => {
            if (c.type === 'added') pc.addIceCandidate(new RTCIceCandidate(c.doc.data())).catch(() => {});
          });
        });
      });
    });

    setIsStreaming(true);
    setStatus("Monitoramento Ativo");
  };

  const updateRemoteControl = async (peerId, updates) => {
    if (!user) return;
    await resumeAudioContext();
    const peerDocRef = getPeerDoc(roomId, peerId);
    const snap = await getDoc(peerDocRef);
    const currentControls = snap.data()?.controls || {};
    await updateDoc(peerDocRef, { controls: { ...currentControls, ...updates } });
  };

  const resetApp = () => {
    Object.values(peerConnections.current).forEach(pc => pc.close());
    peerConnections.current = {};
    if (localStream.current) localStream.current.getTracks().forEach(t => t.stop());
    setRemoteStreams({});
    setFocusedPeerId(null);
    setMode('menu');
    setIsStreaming(false);
    setStatus('Pronto');
    setAudioEnabled(false);
  };

  const toggleFocus = (peerId) => {
    resumeAudioContext();
    if (focusedPeerId === peerId) {
      setFocusedPeerId(null);
      if (document.fullscreenElement) document.exitFullscreen();
    } else {
      setFocusedPeerId(peerId);
      if (containerRef.current) containerRef.current.requestFullscreen().catch(() => setIsSimulatedFs(true));
    }
  };

  return (
    <div onClick={resumeAudioContext} className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans overflow-x-hidden">
      <header className="w-full bg-slate-900 border-b border-slate-800 px-6 py-4 flex items-center justify-between shadow-xl z-20">
        <div className="flex items-center gap-3">
          <div className="bg-blue-600 p-2 rounded-xl"><ShieldCheck size={20} className="text-white" /></div>
          <h1 className="text-sm font-bold uppercase tracking-tighter">SecuriteView P2P</h1>
        </div>
        {mode !== 'menu' && mode !== 'permissions' && (
          <button onClick={resetApp} className="bg-red-500/10 text-red-500 px-4 py-2 rounded-lg text-[10px] font-black border border-red-500/20 active:scale-95 transition-all">SAIR</button>
        )}
      </header>

      <main className="flex-1 w-full max-w-2xl mx-auto p-6 flex flex-col gap-6">
        
        {/* TELA DE PERMISSÕES INICIAIS */}
        {mode === 'permissions' && (
          <div className="flex flex-col items-center justify-center py-20 text-center gap-8">
            <div className="w-24 h-24 bg-blue-600/10 rounded-[2.5rem] flex items-center justify-center border border-blue-500/20 relative">
              <Lock size={40} className="text-blue-500" />
              <div className="absolute -bottom-2 -right-2 bg-slate-950 p-1">
                <CheckCircle2 size={24} className="text-green-500" />
              </div>
            </div>
            <div className="space-y-3">
              <h2 className="text-2xl font-bold">Acesso Necessário</h2>
              <p className="text-slate-400 text-sm max-w-[280px] mx-auto leading-relaxed">
                Para funcionar corretamente, precisamos de acesso à sua <b>Câmera</b> e <b>Microfone</b>.
              </p>
            </div>
            <button 
              onClick={requestPermissions}
              className="w-full max-w-[280px] bg-blue-600 hover:bg-blue-500 py-5 rounded-2xl font-black text-xs tracking-widest shadow-2xl shadow-blue-900/40 active:scale-95 transition-all"
            >
              CONCEDER ACESSO AGORA
            </button>
            <p className="text-[10px] text-slate-600 uppercase font-bold tracking-widest">{status}</p>
          </div>
        )}

        {mode === 'menu' && (
          <div className="flex flex-col gap-4 py-12">
            <button onClick={() => setMode('camera')} className="flex items-center gap-5 p-6 bg-slate-900 border border-slate-800 rounded-3xl hover:bg-slate-800 active:scale-95 transition-all group">
              <Camera size={40} className="text-blue-500 group-hover:scale-110 transition-transform" />
              <div className="text-left">
                <span className="block text-xl font-bold">Modo Câmera</span>
                <span className="text-[10px] text-slate-500 uppercase font-black tracking-widest">Transmitir Dispositivo</span>
              </div>
            </button>
            <button onClick={() => setMode('viewer')} className="flex items-center gap-5 p-6 bg-slate-900 border border-slate-800 rounded-3xl hover:bg-slate-800 active:scale-95 transition-all group">
              <MonitorPlay size={40} className="text-green-500 group-hover:scale-110 transition-transform" />
              <div className="text-left">
                <span className="block text-xl font-bold">Modo Âncora</span>
                <span className="text-[10px] text-slate-500 uppercase font-black tracking-widest">Monitorar Múltiplas Câmeras</span>
              </div>
            </button>
          </div>
        )}

        {mode !== 'menu' && mode !== 'permissions' && (
          <div className="flex flex-col gap-6">
            {!isStreaming && (
               <div className="bg-slate-900 p-6 rounded-[2rem] border border-slate-800 space-y-4 shadow-2xl">
                <input
                  type="text"
                  placeholder="ID DA SALA"
                  value={roomId}
                  onChange={(e) => setRoomId(e.target.value.toUpperCase())}
                  className="w-full bg-slate-950 border border-slate-800 rounded-2xl py-4 text-2xl font-mono text-center outline-none focus:ring-2 focus:ring-blue-600 transition-all"
                />
                <p className="text-[10px] text-slate-500 text-center font-bold tracking-[0.2em] uppercase animate-pulse">{status}</p>
                <button
                  disabled={!roomId || !user}
                  onClick={mode === 'camera' ? startCameraMode : startViewerMode}
                  className={`w-full ${mode === 'camera' ? 'bg-blue-600 shadow-blue-900/40' : 'bg-green-600 shadow-green-900/40'} py-5 rounded-2xl font-black text-xs tracking-widest shadow-xl active:scale-95 transition-all disabled:opacity-30`}
                >
                  {mode === 'camera' ? 'ATIVAR TRANSMISSOR' : 'ATIVAR MONITORAMENTO'}
                </button>
              </div>
            )}

            {isStreaming && (
              <div ref={containerRef} className={`${isSimulatedFs ? 'fixed inset-0 z-50 bg-black' : 'relative min-h-[400px] bg-slate-900 rounded-[2.5rem] border border-slate-800 shadow-2xl overflow-hidden'} flex items-center justify-center`}>
                {mode === 'camera' ? (
                  <div className="flex flex-col items-center gap-6 p-10 text-center">
                      <audio ref={remoteAudioRef} autoPlay playsInline muted={false} />
                      <div className="relative">
                        <div className="w-24 h-24 bg-blue-600/10 rounded-full flex items-center justify-center border-2 border-blue-600/50 animate-pulse">
                            <Video size={48} className="text-blue-500" />
                        </div>
                        {audioEnabled && (
                          <div className="absolute -top-2 -right-2 bg-green-500 p-1.5 rounded-full border-2 border-slate-900">
                            <Volume2 size={14} className="text-white" />
                          </div>
                        )}
                      </div>
                      <div className="px-6 py-2 bg-blue-600/20 rounded-full border border-blue-500/30">
                        <span className="text-[10px] font-black text-blue-400 tracking-[0.3em] uppercase">Transmitindo</span>
                      </div>
                      
                      {!audioEnabled ? (
                        <button 
                          onClick={resumeAudioContext}
                          className="flex items-center gap-3 bg-white text-black px-6 py-4 rounded-2xl font-black text-[10px] tracking-widest active:scale-95 transition-all shadow-2xl"
                        >
                          <Headphones size={18} /> ATIVAR ÁUDIO DE RETORNO
                        </button>
                      ) : (
                        <p className="text-[10px] text-slate-500 uppercase font-bold opacity-50 max-w-[200px]">
                          Áudio de retorno ativo. Você ouvirá o monitor aqui.
                        </p>
                      )}
                  </div>
                ) : (
                  <div className={`w-full h-full p-2 transition-all duration-500 ${focusedPeerId ? 'flex' : 'grid grid-cols-1 sm:grid-cols-2 gap-2'}`}>
                    {Object.entries(remoteStreams)
                      .filter(([id]) => !focusedPeerId || id === focusedPeerId)
                      .map(([id, stream]) => {
                        const cfg = activePeerConfigs[id] || { zoom: 1, rotation: 0, remoteMic: true, anchorMic: true };
                        return (
                          <div key={id} className={`relative group bg-black rounded-3xl overflow-hidden flex items-center justify-center border border-white/5 transition-all duration-500 ${focusedPeerId ? 'w-full h-full' : 'aspect-video'}`}>
                            <video 
                              autoPlay playsInline muted={false}
                              ref={el => { if (el && el.srcObject !== stream) { el.srcObject = stream; el.muted = false; el.play().catch(()=>{}); } }}
                              className="object-contain transition-transform duration-300 pointer-events-none"
                              style={{ 
                                transform: `rotate(${cfg.rotation}deg) scale(${cfg.zoom})`,
                                width: cfg.rotation % 180 !== 0 ? (focusedPeerId ? '50%' : '70%') : '100%',
                                height: cfg.rotation % 180 !== 0 ? (focusedPeerId ? '150%' : '130%') : '100%'
                              }}
                            />
                            <div className={`absolute inset-x-0 bottom-6 flex justify-center transition-all ${focusedPeerId ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                              <div className="flex items-center gap-3 bg-black/60 backdrop-blur-2xl p-3 rounded-3xl border border-white/10 shadow-2xl scale-90 sm:scale-100">
                                <button onClick={() => updateRemoteControl(id, { zoom: Math.max(1, (cfg.zoom || 1) - 0.2) })} className="p-2 bg-white/5 rounded-xl"><Minus size={18}/></button>
                                <span className="text-[10px] font-bold w-8 text-center">{cfg.zoom?.toFixed(1)}x</span>
                                <button onClick={() => updateRemoteControl(id, { zoom: Math.min(4, (cfg.zoom || 1) + 0.2) })} className="p-2 bg-white/5 rounded-xl"><Plus size={18}/></button>
                                <div className="w-px h-6 bg-white/10 mx-1" />
                                <button onClick={() => updateRemoteControl(id, { rotation: (cfg.rotation || 0) === 0 ? 90 : 0 })} className="p-2 bg-white/5 rounded-xl"><RotateCw size={18}/></button>
                                <button onClick={() => updateRemoteControl(id, { remoteMic: !cfg.remoteMic })} className={`p-2 rounded-xl transition-all ${cfg.remoteMic ? 'bg-green-600' : 'bg-red-600'}`}>
                                  {cfg.remoteMic ? <Volume2 size={18}/> : <VolumeX size={18}/>}
                                </button>
                                <button onClick={() => updateRemoteControl(id, { anchorMic: !cfg.anchorMic })} className={`p-2 rounded-xl transition-all ${cfg.anchorMic ? 'bg-blue-600 shadow-lg' : 'bg-white/5 text-slate-400'}`}>
                                  {cfg.anchorMic ? <Mic size={18}/> : <MicOff size={18}/>}
                                </button>
                                <div className="w-px h-6 bg-white/10 mx-1" />
                                <button onClick={() => toggleFocus(id)} className={`p-2 rounded-xl transition-all ${focusedPeerId ? 'bg-orange-500' : 'bg-white/5'}`}>
                                  {focusedPeerId ? <Minimize size={18} /> : <Maximize size={18} />}
                                </button>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </main>
      <footer className="p-8 text-slate-800 text-[8px] uppercase tracking-[0.4em] font-black text-center opacity-40">P2P Secure Multicam • v2.5 Ultra</footer>
    </div>
  );
}