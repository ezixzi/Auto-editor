import {useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent} from 'react';
import {Player, type PlayerRef} from '@remotion/player';
import {
  ArrowDownToLine, ArrowRight, AudioLines, Check, ChevronDown, CircleHelp,
  Clapperboard, Film, Folder, ImagePlus, Layers3, LoaderCircle,
  Maximize, Music2, Pause, Play, Plus, RotateCcw,
  SlidersHorizontal, Sparkles, Trash2, Upload, Volume2, X, Zap,
} from 'lucide-react';
import {DEFAULT_SETTINGS, type Aspect, type EditPlan, type EditorSettings, type MediaAsset, type RenderJob} from '../shared/types';
import {EditVideo} from '../video/EditVideo';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Permintaan gagal (${response.status}). Coba lagi.`);
  return data as T;
}
const post = (body: unknown): RequestInit => ({method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
const clock = (seconds: number) => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
const kinds = {title: 'Pembuka', clip: 'Footage', reveal: 'Reveal', outro: 'Penutup'};
const storageKey = 'forma-editor-v1';
interface SavedEditor {settings: EditorSettings; selected: string[]; musicId?: string; dismissed: string[];}
function readSavedEditor(): SavedEditor {
  const fallback: SavedEditor = {settings: {...DEFAULT_SETTINGS}, selected: [], dismissed: []};
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || 'null');
    if (!value || typeof value !== 'object') return fallback;
    const raw = value.settings || {};
    return {
      settings: {
        title: typeof raw.title === 'string' ? raw.title.slice(0, 60) : DEFAULT_SETTINGS.title,
        subtitle: typeof raw.subtitle === 'string' ? raw.subtitle.slice(0, 120) : DEFAULT_SETTINGS.subtitle,
        theme: raw.theme === 'white' ? 'white' : 'black',
        aspect: ['16:9', '9:16', '1:1'].includes(raw.aspect) ? raw.aspect : '16:9',
        duration: Number.isFinite(raw.duration) ? Math.max(6, Math.min(60, raw.duration)) : DEFAULT_SETTINGS.duration,
        bpm: Number.isFinite(raw.bpm) ? Math.max(40, Math.min(220, raw.bpm)) : DEFAULT_SETTINGS.bpm,
        musicVolume: Number.isFinite(raw.musicVolume) ? Math.max(0, Math.min(1, raw.musicVolume)) : DEFAULT_SETTINGS.musicVolume,
        sfx: typeof raw.sfx === 'boolean' ? raw.sfx : DEFAULT_SETTINGS.sfx,
      },
      selected: Array.isArray(value.selected) ? value.selected.filter((id: unknown) => typeof id === 'string') : [],
      musicId: typeof value.musicId === 'string' ? value.musicId : undefined,
      dismissed: Array.isArray(value.dismissed) ? value.dismissed.filter((id: unknown) => typeof id === 'string') : [],
    };
  } catch { return fallback; }
}


export function App() {
  const [saved] = useState(readSavedEditor);
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [libraryReady, setLibraryReady] = useState(false);
  const [dismissed, setDismissed] = useState<string[]>(saved.dismissed);
  const [selected, setSelected] = useState<string[]>(saved.selected);
  const [musicId, setMusicId] = useState<string | undefined>(saved.musicId);
  const [settings, setSettings] = useState<EditorSettings>(saved.settings);
  const [plan, setPlan] = useState<EditPlan>();
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState<'upload' | 'demo' | 'plan' | 'render' | undefined>();
  const [job, setJob] = useState<RenderJob>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [online, setOnline] = useState<boolean>();
  const [dragging, setDragging] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [frame, setFrame] = useState(0);
  const [tab, setTab] = useState<'all' | 'video' | 'audio'>('all');
  const [guideOpen, setGuideOpen] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const player = useRef<PlayerRef>(null);
  const mediaSection = useRef<HTMLElement>(null);
  const guideDialog = useRef<HTMLDialogElement>(null);
  const working = !!busy || !libraryReady;
  const rendering = job?.status === 'queued' || job?.status === 'rendering';
  const videos = assets.filter((a) => a.kind === 'video');
  const music = assets.filter((a) => a.kind === 'audio');
  const visibleAssets = assets.filter((a) => tab === 'all' || a.kind === tab);
  const currentTime = plan ? frame / plan.fps : 0;
  const totalTime = plan ? plan.durationInFrames / plan.fps : settings.duration;
  const activeScene = plan?.scenes.find((scene) => frame >= scene.from && frame < scene.from + scene.duration);

  useEffect(() => {
    let active = true;
    request<{assets: MediaAsset[]}>('/api/assets').then((result) => {
      if (!active) return;
      const available = result.assets.filter((asset) => !saved.dismissed.includes(asset.id));
      setAssets(available);
      setSelected((current) => current.filter((id) => available.some((asset) => asset.id === id && asset.kind === 'video')));
      setMusicId((current) => available.some((asset) => asset.id === current && asset.kind === 'audio') ? current : undefined);
    }).catch(() => { if (active) setError('Media tersimpan belum dapat dimuat. Periksa koneksi engine.'); }).finally(() => { if (active) setLibraryReady(true); });
    request<{ok: boolean; ffmpeg: boolean}>('/api/health').then((health) => { if (active) setOnline(health.ok && health.ffmpeg); }).catch(() => { if (active) setOnline(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!libraryReady) return;
    try { localStorage.setItem(storageKey, JSON.stringify({settings, selected, musicId, dismissed})); } catch { /* The editor also works when browser storage is unavailable. */ }
  }, [settings, selected, musicId, dismissed, libraryReady]);

  useEffect(() => {
    const instance = player.current;
    if (!instance || !plan) return;
    const onFrame = (event: {detail: {frame: number}}) => setFrame(event.detail.frame);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    instance.addEventListener('frameupdate', onFrame);
    instance.addEventListener('play', onPlay);
    instance.addEventListener('pause', onPause);
    instance.addEventListener('ended', onPause);
    return () => {
      instance.removeEventListener('frameupdate', onFrame);
      instance.removeEventListener('play', onPlay);
      instance.removeEventListener('pause', onPause);
      instance.removeEventListener('ended', onPause);
    };
  }, [plan]);

  useEffect(() => {
    if (!job || !['queued', 'rendering'].includes(job.status)) return;
    let stopped = false;
    let timeout: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await request<{job: RenderJob}>(`/api/render/${job.id}`);
        if (stopped) return;
        setJob(result.job);
        if (result.job.status === 'error') setError(result.job.error || 'Video belum berhasil dirender. Silakan coba lagi.');
        if (result.job.status === 'done') setNotice('Film Anda siap. Unduh video untuk menyimpannya.');
        if (['queued', 'rendering'].includes(result.job.status)) timeout = setTimeout(poll, 1200);
      } catch (cause) {
        if (!stopped) {
          setError(cause instanceof Error ? cause.message : 'Status render tidak dapat dimuat.');
          timeout = setTimeout(poll, 4000);
        }
      }
    };
    timeout = setTimeout(poll, 800);
    return () => { stopped = true; clearTimeout(timeout); };
  }, [job?.id, job?.status]);

  useEffect(() => {
    const dialog = guideDialog.current;
    if (guideOpen && dialog && !dialog.open) dialog.showModal();
    if (!guideOpen && dialog?.open) dialog.close();
  }, [guideOpen]);

  const markChanged = () => { if (plan) setStale(true); setNotice(undefined); };
  const updateSetting = <K extends keyof EditorSettings>(key: K, value: EditorSettings[K]) => {
    setSettings((current) => ({...current, [key]: value}));
    markChanged();
  };
  const addAssets = (incoming: MediaAsset[]) => {
    setAssets((current) => [...new Map([...current, ...incoming].map((asset) => [asset.id, asset])).values()]);
    setSelected((current) => [...new Set([...current, ...incoming.filter((a) => a.kind === 'video').map((a) => a.id)])]);
    setDismissed((current) => current.filter((id) => !incoming.some((asset) => asset.id === id)));
    const audio = incoming.find((a) => a.kind === 'audio');
    if (audio) setMusicId(audio.id);
    markChanged();
  };
  const uploadFiles = async (files: FileList | File[]) => {
    if (!files.length || working || rendering) return;
    setBusy('upload'); setError(undefined); setNotice(undefined);
    const form = new FormData();
    Array.from(files).forEach((file) => form.append('files', file));
    try {
      const result = await request<{assets: MediaAsset[]}>('/api/assets', {method: 'POST', body: form});
      addAssets(result.assets);
      setNotice(`${result.assets.length} media ditambahkan. Siap untuk dirangkai.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unggah media gagal.'); }
    finally { setBusy(undefined); if (fileInput.current) fileInput.current.value = ''; }
  };
  const loadDemo = async () => {
    setBusy('demo'); setError(undefined); setNotice(undefined);
    try {
      const result = await request<{assets: MediaAsset[]}>('/api/demo', {method: 'POST'});
      addAssets(result.assets);
      setNotice('Demo dimuat: footage produk dan musik. Klik Buat auto edit untuk mulai.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Demo tidak dapat dimuat.'); }
    finally { setBusy(undefined); }
  };
  const generatePlan = async () => {
    if (!selected.length) { setError('Tambahkan dan pilih setidaknya satu video terlebih dahulu.'); return; }
    setBusy('plan'); setError(undefined); setNotice(undefined); setPlaying(false);
    player.current?.pause();
    try {
      const result = await request<{plan: EditPlan}>('/api/plan', post({assetIds: selected, musicId, settings}));
      setPlan(result.plan); setStale(false); setFrame(0); setJob(undefined);
      setNotice('Auto edit selesai. Putar pratinjau, lalu ekspor film Anda.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Auto edit belum berhasil.'); }
    finally { setBusy(undefined); }
  };
  const startRender = async () => {
    if (!plan || stale) return;
    setBusy('render'); setError(undefined); setNotice(undefined);
    try { const result = await request<{job: RenderJob}>('/api/render', post({planId: plan.id})); setJob(result.job); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Render gagal dimulai.'); }
    finally { setBusy(undefined); }
  };
  const cancelRender = async () => {
    if (!job) return;
    setCancelBusy(true);
    try { const result = await request<{job: RenderJob}>(`/api/render/${job.id}`, {method: 'DELETE'}); setJob(result.job); setNotice('Render dibatalkan. Anda dapat mengekspor kembali.'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Render gagal dibatalkan.'); }
    finally { setCancelBusy(false); }
  };
  const removeAsset = (id: string) => {
    setDismissed((current) => [...current, id]);
    setAssets((current) => current.filter((a) => a.id !== id));
    setSelected((current) => current.filter((selectedId) => selectedId !== id));
    if (musicId === id) setMusicId(undefined);
    markChanged();
  };
  const toggleAsset = (asset: MediaAsset) => {
    if (asset.kind === 'audio') setMusicId((current) => current === asset.id ? undefined : asset.id);
    else setSelected((current) => current.includes(asset.id) ? current.filter((id) => id !== asset.id) : [...current, asset.id]);
    markChanged();
  };
  const handleDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault(); setDragging(false); void uploadFiles(event.dataTransfer.files);
  };
  const seek = useCallback((newFrame: number) => { player.current?.seekTo(newFrame); setFrame(newFrame); }, []);
  const askUpload = () => fileInput.current?.click();
  const dropHandlers = {
    onDragOver: (event: DragEvent<HTMLElement>) => { event.preventDefault(); if (!working && !rendering) setDragging(true); },
    onDragLeave: (event: DragEvent<HTMLElement>) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); },
    onDrop: handleDrop,
  };

  return <div className="app-shell">
    <input ref={fileInput} type="file" className="sr-only" accept="video/*,audio/*,.mp4,.mov,.mkv,.webm,.mp3,.wav,.m4a,.ogg,.flac" multiple onChange={(event: ChangeEvent<HTMLInputElement>) => { if (event.target.files) void uploadFiles(event.target.files); }} aria-label="Unggah video atau audio" />
    <aside className="sidebar">
      <a className="brand" href="#" aria-label="Forma Auto Editor"><span className="brand-symbol"><span /><span /></span><span>forma<span className="brand-dot">.</span></span></a>
      <div className="workspace-select"><span className="workspace-avatar">F</span><div><strong>Personal workspace</strong><span>Ruang untuk ide besar</span></div><ChevronDown size={13} /></div>
      <div className="nav-caption">WORKSPACE</div>
      <nav aria-label="Navigasi utama">
        <button className="nav-item active" onClick={() => window.scrollTo({top: 0, behavior: 'smooth'})}><Clapperboard size={18} />Editor<span className="nav-active-dot" /></button>
        <button className="nav-item" onClick={() => mediaSection.current?.scrollIntoView({behavior: 'smooth', block: 'center'})}><Folder size={18} />Media library<span className="nav-count">{assets.length}</span></button>
        <button className="nav-item" onClick={() => setGuideOpen(true)}><Layers3 size={18} />Panduan gaya<ArrowRight size={14} className="nav-trailing" /></button>
      </nav>
      <div className="sidebar-divider" />
      <div className="nav-caption">THE CREATIVE PROCESS</div>
      <ol className="workflow">
        <li className={assets.length ? 'completed' : 'current'}><span className="step-number">{assets.length ? <Check size={12} /> : '01'}</span><div><strong>Bring your footage</strong><p>Mulai dari yang Anda punya.</p></div></li>
        <li className={plan ? 'completed' : assets.length ? 'current' : ''}><span className="step-number">{plan ? <Check size={12} /> : '02'}</span><div><strong>Find your rhythm</strong><p>Biarkan detailnya bicara.</p></div></li>
        <li className={job?.status === 'done' ? 'completed' : plan ? 'current' : ''}><span className="step-number">{job?.status === 'done' ? <Check size={12} /> : '03'}</span><div><strong>Make an impression</strong><p>Satu film. Banyak cerita.</p></div></li>
      </ol>
      <div className="sidebar-bottom">
        <div className="philosophy-card"><div className="tiny-mark">✳</div><p>Great things.<br />Less things.</p><span>Ruang kosong juga<br />punya sesuatu untuk dikatakan.</span><button onClick={() => setGuideOpen(true)}>Filosofi di balik Forma <ArrowRight size={13} /></button></div>
        <div className="engine-status"><span className={`status-dot ${online === false ? 'offline' : online === undefined ? 'pending' : ''}`} />{online === undefined ? 'Menghubungkan engine' : online ? 'Engine siap bekerja' : 'Engine belum tersedia'}<span>v1.0</span></div>
      </div>
    </aside>

    <main className="main-content">
      <header className="topbar"><div className="breadcrumbs">WORKSPACE <span>/</span> <strong>AUTO EDITOR</strong></div><div className="topbar-right"><span className="local-badge"><span />Local processing</span><button className="icon-button help-button" aria-label="Buka panduan" onClick={() => setGuideOpen(true)}><CircleHelp size={18} /></button><div className="user-avatar">F</div></div></header>
      <div className="page-content">
        <div className="page-heading"><div><div className="eyebrow"><span />THE ART OF LESS</div><h1>Make every frame matter<span>.</span></h1><p>Footage Anda. Ritme yang tepat. Sesederhana itu.</p></div><div className="heading-actions">{job?.status === 'done' && job.url && !stale ? <a data-testid="download-link" className="button primary export-button" href={job.url} download><ArrowDownToLine size={15} />Unduh video<Check size={13} /></a> : <button data-testid="export-button" className="button export-button" onClick={() => void startRender()} disabled={!plan || stale || working || rendering}>{rendering || busy === 'render' ? <LoaderCircle className="spin" size={16} /> : <ArrowDownToLine size={16} />}{rendering ? `${Math.round((job?.progress || 0) * 100)}% rendering` : 'Ekspor video'}<span className="format-badge">MP4</span></button>}</div></div>

        {(error || notice) && <div className={`feedback ${error ? 'error' : 'success'}`} role={error ? 'alert' : 'status'}><span>{error ? <CircleHelp size={16} /> : <Check size={16} />}{error || notice}</span><button className="icon-button" onClick={() => { setError(undefined); setNotice(undefined); }} aria-label="Tutup notifikasi"><X size={15} /></button></div>}
        {rendering && <div className="render-progress" data-testid="job-status" role="status"><div><span><LoaderCircle className="spin" size={15} />Merangkai film Anda{job?.status === 'queued' ? ' · menyiapkan renderer' : ' · rendering'}</span><button onClick={() => void cancelRender()} disabled={cancelBusy}>{cancelBusy ? 'Membatalkan…' : 'Batalkan'}<X size={12} /></button></div><progress value={job?.progress || 0} max={1} aria-label="Progres render" /></div>}

        <div className="editor-grid">
          <section className="preview-panel" aria-label="Pratinjau video">
            <div className="panel-toolbar"><div className="section-label"><span className="live-dot" />PREVIEW <span className="subtle-label">{plan ? `${plan.width} × ${plan.height}` : 'Your story starts here'}</span></div><div className="aspect-switch" aria-label="Rasio video">{(['16:9', '9:16', '1:1'] as Aspect[]).map((aspect) => <button key={aspect} className={settings.aspect === aspect ? 'selected' : ''} aria-pressed={settings.aspect === aspect} disabled={working || rendering} onClick={() => updateSetting('aspect', aspect)}>{aspect}</button>)}</div></div>
            <div data-testid="preview-player" className={`preview-stage ${dragging ? 'dragging' : ''}`} {...dropHandlers}>
              {plan ? <Player key={plan.id} ref={player} component={EditVideo} inputProps={{plan}} durationInFrames={plan.durationInFrames} fps={plan.fps} compositionWidth={plan.width} compositionHeight={plan.height} style={{width: '100%', height: '100%'}} controls={false} clickToPlay={true} spaceKeyToPlayOrPause={false} moveToBeginningWhenEnded={false} /> : <div className="empty-film"><div className="preview-sample-label">A STUDY IN SIMPLICITY <span>01 — 03</span></div><div className="sample-copy"><span>LESS NOISE. MORE FEELING.</span><h2>Less.<br /><span>But better.</span></h2><p>Let the details do the talking.</p></div><div className="product-sculpture" aria-hidden="true"><div className="sculpture-shadow" /><div className="sculpture-back" /><div className="sculpture-front"><div className="sculpture-inner" /><div className="sculpture-shine" /></div><div className="sculpture-dot" /></div><div className="sample-footer"><span>FORMA — STYLE PREVIEW</span><span>DESIGNED TO FEEL DIFFERENT</span></div></div>}
              {stale && <div className="stale-overlay"><span>Pengaturan berubah</span><button onClick={() => void generatePlan()} disabled={working || rendering}><RotateCcw size={12} />Perbarui edit</button></div>}
              {dragging && <div className="drop-overlay"><Upload size={30} /><strong>Lepaskan media di sini</strong><span>Video, musik, dan ide besar Anda.</span></div>}
              {busy === 'plan' && <div className="planning-overlay" role="status"><div className="planning-icon"><AudioLines size={27} /></div><strong>Menemukan ritme cerita Anda.</strong><span>Menganalisis audio & menyusun setiap potongan…</span><div className="planning-dots"><span /><span /><span /></div></div>}
            </div>
            <div className="playback-bar"><div className="playback-left"><button className="play-button" disabled={!plan || busy === 'plan'} aria-label={playing ? 'Jeda pratinjau' : 'Putar pratinjau'} onClick={() => playing ? player.current?.pause() : player.current?.play()}>{playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}</button><span className="timecode">{clock(currentTime)}<span>/ {clock(totalTime)}</span></span></div><div className="playback-middle">{plan ? <><span className="status-dot" />{activeScene ? kinds[activeScene.kind] : 'Siap diputar'}</> : <><span className="empty-indicator" />Pratinjau gaya · muat media untuk mulai</>}</div><div className="playback-right"><span>{plan?.fps || 30} FPS</span><button className="icon-button" disabled={!plan} aria-label="Pratinjau layar penuh" onClick={() => player.current?.requestFullscreen()}><Maximize size={15} /></button></div></div>

            <div className="timeline" data-testid="timeline"><div className="timeline-heading"><div><Layers3 size={13} /><strong>Timeline</strong><span>{plan ? `${plan.scenes.length} scenes` : 'Menunggu cerita Anda'}</span></div><span className="beat-label"><AudioLines size={13} />{plan ? `${Math.round(plan.analysis.bpm)} BPM · ${plan.analysis.source === 'detected' ? 'Beat terdeteksi' : 'Beat grid'}` : 'Beat-synced, by design'}</span></div>
              {plan ? <><div className="timeline-ruler"><span>00:00</span><span>{clock(totalTime / 4)}</span><span>{clock(totalTime / 2)}</span><span>{clock(totalTime * .75)}</span><span>{clock(totalTime)}</span></div><div className="scene-track">{plan.scenes.map((scene, index) => <button key={scene.id} className={`scene scene-${scene.kind} ${activeScene?.id === scene.id ? 'scene-active' : ''}`} style={{flexBasis: `${scene.duration / plan.durationInFrames * 100}%`}} onClick={() => seek(scene.from)} title={`${scene.label} · ${clock(scene.from / plan.fps)}`} aria-label={`Lompat ke adegan ${index + 1}: ${scene.label}`}><span>{String(index + 1).padStart(2, '0')}</span><strong>{kinds[scene.kind]}</strong></button>)}<div className="timeline-playhead" style={{left: `${frame / plan.durationInFrames * 100}%`}} /></div><input className="timeline-seek" type="range" min={0} max={plan.durationInFrames - 1} value={frame} onChange={(event) => seek(Number(event.target.value))} aria-label="Posisi pemutaran video" /><div className="audio-track" aria-label={plan.musicUrl ? 'Gelombang audio' : 'Grid ritme tanpa musik'}><Music2 size={12} /><div className="waveform">{plan.analysis.waveform.slice(0, 160).map((value, index) => <span key={index} style={{height: `${Math.max(8, Math.min(100, value * 100))}%`}} />)}{!plan.analysis.waveform.length && <span className="audio-empty">{plan.musicUrl ? 'Musik terpasang' : 'Tanpa musik · menggunakan beat grid'}</span>}</div><span className="audio-track-caption">{plan.musicUrl ? 'AUDIO' : 'BEAT GRID'}</span></div></> : <div className="empty-timeline"><span className="empty-track-title">01</span><div className="empty-track-line" /><span className="empty-track-title">02</span><div className="empty-track-line" /><span className="empty-track-title">03</span><div className="empty-track-line" /><span><Sparkles size={13} />Dibuat otomatis, mengikuti beat</span></div>}
            </div>
            {plan?.warnings.length ? <div className="plan-warnings">{plan.warnings.map((warning, i) => <p key={i}><CircleHelp size={13} />{warning}</p>)}</div> : null}
          </section>

          <aside className="inspector" aria-label="Pengaturan edit">
            <div className="inspector-heading"><div><SlidersHorizontal size={16} /><h2>Make it yours</h2></div><span>01</span></div>
            <div className="style-choice"><div className="style-icon"><span>a</span><span>↗</span></div><div><span className="overline">EDITING STYLE</span><strong>Minimal. Intentional.</strong><p>Terinspirasi estetika Apple.</p></div><span className="style-check"><Check size={12} /></span></div>
            <fieldset disabled={working || rendering} className="settings-fields"><legend className="sr-only">Sesuaikan film Anda</legend>
              <div className="field-section"><div className="field-section-label">01 <span>CERITA ANDA</span></div><label htmlFor="title">Headline<span>Maks. 60 karakter</span></label><input data-testid="title-input" id="title" className="text-input" value={settings.title} maxLength={60} placeholder="Less. But better." onChange={(event) => updateSetting('title', event.target.value)} /><label htmlFor="subtitle">Subheadline <span>Opsional</span></label><input id="subtitle" className="text-input" value={settings.subtitle} maxLength={120} placeholder="Every detail matters." onChange={(event) => updateSetting('subtitle', event.target.value)} /></div>
              <div className="field-section"><div className="field-section-label">02 <span>LOOK & FEEL</span></div><label>Tema visual</label><div className="theme-options"><button type="button" className={settings.theme === 'black' ? 'selected' : ''} onClick={() => updateSetting('theme', 'black')} aria-pressed={settings.theme === 'black'}><span className="theme-swatch black">Aa</span><span>Pure black</span>{settings.theme === 'black' && <Check size={12} />}</button><button type="button" className={settings.theme === 'white' ? 'selected' : ''} onClick={() => updateSetting('theme', 'white')} aria-pressed={settings.theme === 'white'}><span className="theme-swatch white">Aa</span><span>Pure white</span>{settings.theme === 'white' && <Check size={12} />}</button></div><label htmlFor="duration" className="range-label">Durasi film<strong>{settings.duration}<span> detik</span></strong></label><input data-testid="duration-input" id="duration" className="range-input" type="range" min={6} max={60} step={1} value={settings.duration} onChange={(event) => updateSetting('duration', Number(event.target.value))} /><div className="range-endpoints"><span>6s · Singkat</span><span>60s · Bercerita</span></div></div>
              <div className="field-section audio-settings"><div className="field-section-label">03 <span>RHYTHM & SOUND</span></div><label htmlFor="music">Soundtrack <Music2 size={12} /></label><div className="select-wrapper"><select id="music" value={musicId || ''} onChange={(event) => { setMusicId(event.target.value || undefined); markChanged(); }}><option value="">Tanpa musik</option>{music.map((asset) => <option value={asset.id} key={asset.id}>{asset.name}</option>)}</select><ChevronDown size={13} /></div><div className="audio-options"><label htmlFor="bpm">Beat fallback<input id="bpm" type="number" min={40} max={220} step={1} value={settings.bpm} onChange={(event) => updateSetting('bpm', Math.min(220, Math.max(40, Number(event.target.value) || 40)))} /><span>BPM</span></label><label htmlFor="volume">Volume<strong>{Math.round(settings.musicVolume * 100)}%</strong><input id="volume" type="range" min={0} max={1} step={0.05} value={settings.musicVolume} onChange={(event) => updateSetting('musicVolume', Number(event.target.value))} /></label></div><label className="toggle-label" htmlFor="sfx"><span><Volume2 size={14} />SFX halus</span><input id="sfx" type="checkbox" checked={settings.sfx} onChange={(event) => updateSetting('sfx', event.target.checked)} /><span className="switch" aria-hidden="true" /></label></div>
            </fieldset>
            <div className="generate-section"><button data-testid="generate-button" className="button generate-button" disabled={!selected.length || working || rendering || !settings.title.trim()} onClick={() => void generatePlan()}>{busy === 'plan' ? <LoaderCircle size={17} className="spin" /> : <Sparkles size={17} />}{busy === 'plan' ? 'Merangkai cerita…' : plan ? 'Perbarui auto edit' : 'Buat auto edit'}<ArrowRight size={16} /></button><p><Zap size={11} />Beat sync · Clean cuts · Smooth motion</p></div>
          </aside>

          <section className={`media-panel ${dragging ? 'media-dragging' : ''}`} ref={mediaSection} aria-label="Media library" {...dropHandlers}>
            <div className="media-heading"><div><h2>Your raw materials<span>{assets.length.toString().padStart(2, '0')}</span></h2><p>Setiap cerita hebat dimulai dari satu klip.</p></div><div className="media-actions"><button data-testid="demo-button" className="button small-button demo-heading-button" onClick={() => void loadDemo()} disabled={working || rendering}>{busy === 'demo' ? <LoaderCircle size={13} className="spin" /> : <Play size={12} />}Muat demo</button><button className="button small-button" onClick={askUpload} disabled={working || rendering}>{busy === 'upload' ? <LoaderCircle size={14} className="spin" /> : <Plus size={15} />}Tambah media</button></div></div>
            {assets.length ? <><div className="media-tabs" role="group" aria-label="Filter media">{([{key: 'all', label: 'Semua', count: assets.length}, {key: 'video', label: 'Video', count: videos.length}, {key: 'audio', label: 'Audio', count: music.length}] as const).map((item) => <button key={item.key} className={tab === item.key ? 'active' : ''} onClick={() => setTab(item.key)}>{item.label}<span>{item.count}</span></button>)}<span className="selection-count">{selected.length} video dipilih</span></div><div className="asset-grid">{visibleAssets.map((asset) => { const isSelected = asset.kind === 'video' ? selected.includes(asset.id) : musicId === asset.id; return <div data-testid="asset-card" className={`asset-card ${isSelected ? 'selected' : ''}`} key={asset.id}><button className="asset-select" disabled={working || rendering} aria-label={`${isSelected ? 'Batalkan pilihan' : 'Pilih'} ${asset.name}`} aria-pressed={isSelected} onClick={() => toggleAsset(asset)}><div className={`asset-thumbnail ${asset.kind === 'audio' ? 'audio-thumbnail' : ''}`}>{asset.thumbnail ? <img src={asset.thumbnail} alt="" /> : asset.kind === 'audio' ? <AudioLines size={31} /> : <Film size={28} />}<span className="asset-duration">{clock(asset.duration)}</span><span className="asset-check">{isSelected && <Check size={10} />}</span></div><div className="asset-title"><span>{asset.name}</span><small>{asset.kind === 'video' ? `${asset.width} × ${asset.height}` : 'AUDIO TRACK'}</small></div></button><button className="asset-delete" aria-label={`Hapus dari proyek: ${asset.name}`} onClick={() => removeAsset(asset.id)} disabled={working || rendering}><Trash2 size={12} /></button></div>; })}<button className="add-asset-card" onClick={askUpload} disabled={working || rendering}><Plus size={22} /><span>Tambah media</span></button></div></> : <div className="upload-empty"><button className="dropzone" onClick={askUpload} disabled={working || rendering}><span className="upload-icon"><ImagePlus size={22} /></span><strong>{busy === 'upload' ? 'Mengunggah media…' : 'Drop footage. Find the magic.'}</strong><span>Tarik video & audio ke sini, atau <u>pilih file</u></span><small>MP4, MOV, WEBM · MP3, WAV & lainnya</small></button><div className="demo-invite"><div className="demo-art" aria-hidden="true"><span /><span /><span /></div><span className="overline">JUST EXPLORING?</span><h3>Lihat apa yang<br />bisa Anda buat.</h3><p>Coba footage dan musik demo<br />yang kami siapkan.</p><button onClick={() => void loadDemo()} disabled={working || rendering}>{busy === 'demo' ? <LoaderCircle size={14} className="spin" /> : <Play size={12} fill="currentColor" />}{busy === 'demo' ? 'Menyiapkan demo…' : 'Muat demo'}<ArrowRight size={13} /></button></div></div>}
          </section>
        </div>
        <footer className="page-footer"><span><span className="footer-logo">f.</span> Made for the details.</span><span>MINIMAL EFFORT. MAXIMUM FEELING.<span className="footer-spark">✳</span></span></footer>
      </div>
    </main>
    <dialog ref={guideDialog} className="guide-dialog" onCancel={() => setGuideOpen(false)} onClick={(event) => { if (event.target === event.currentTarget) setGuideOpen(false); }}><div className="guide-header"><div><span className="eyebrow">THE FORMA PHILOSOPHY</span><h2>Less, with intention.</h2></div><button className="icon-button" onClick={() => setGuideOpen(false)} aria-label="Tutup panduan"><X size={20} /></button></div><p>Forma merangkai footage mengikuti panduan estetika Apple: kontras murni, tipografi yang tenang, dan potongan yang mengikuti ritme.</p><ol><li><strong>Pilih footage yang bersih.</strong><span>Subjek terisolasi, pencahayaan kontras, serta detail close-up membuat hasil lebih kuat. Pilihan otomatis membantu, namun kualitas footage tetap penting.</span></li><li><strong>Tambahkan musik, temukan beat.</strong><span>Audio dianalisis untuk menentukan potongan. Tanpa musik atau beat yang jelas, Forma memakai BPM fallback Anda.</span></li><li><strong>Berikan ruang untuk momen utama.</strong><span>Pembuka tipografi, potongan dinamis, jeda audio, dan reveal lebih lambat membangun cerita.</span></li><li><strong>Pratinjau, lalu ekspor.</strong><span>Ubah headline, tema, rasio, atau durasi. Buat ulang edit setelah perubahan, lalu ekspor menjadi MP4.</span></li></ol><div className="guide-note"><Folder size={17} /><span>Media diproses di server workspace ini. Gunakan footage dan musik yang boleh Anda gunakan.</span></div><button className="button primary" onClick={() => setGuideOpen(false)}>Mulai berkarya<ArrowRight size={15} /></button></dialog>
  </div>;
}
