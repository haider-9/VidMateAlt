import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowDownToLine, Check, ChevronDown, CircleHelp, Clock3, Compass, Download, FileVideo2, FolderOpen, Link2, LoaderCircle, Moon, Play, Plus, Search, Settings2, Sun, UserRound, X } from "lucide-react";
import "./App.css";

type DownloadItem = {
  id: string;
  url: string;
  name: string;
  state: "downloading" | "complete" | "failed" | "cancelled";
  received: number;
  total: number | null;
  path?: string;
  message?: string;
};

type AppView = "videos" | "downloads";
type VideoItem = { id: string; title: string; detail?: string; channel?: string; thumbnail?: string; publishedAt?: string };
type YoutubeFeed = { videos: VideoItem[]; subscriptions: number };

const featuredVideos: VideoItem[] = [
  { id: "jNQXAC9IVRw", title: "Me at the zoo", detail: "The first video uploaded to YouTube" },
  { id: "YE7VzlLtp-4", title: "Big Buck Bunny", detail: "An open movie from Blender Foundation" },
];

const savedGoogleClientId = () => {
  try { return localStorage.getItem("vidmatealt-google-client-id") ?? ""; } catch { return ""; }
};

const savedTheme = (): "light" | "dark" => {
  try { return localStorage.getItem("vidmatealt-theme") === "dark" ? "dark" : "light"; } catch { return "light"; }
};

const base64Url = (bytes: Uint8Array) => {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
};

const readableSize = (bytes: number) => {
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1_000))} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
};

const itemName = (url: string) => {
  try {
    const name = new URL(url).pathname.split("/").filter(Boolean).pop();
    return name ? decodeURIComponent(name) : new URL(url).hostname;
  } catch {
    return url;
  }
};

const youtubeVideoId = (value: string) => {
  try {
    const parsed = new URL(value.trim());
    const id = parsed.hostname === "youtu.be"
      ? parsed.pathname.split("/").filter(Boolean)[0]
      : parsed.searchParams.get("v") ?? parsed.pathname.match(/\/(?:embed|shorts)\/([^/?]+)/)?.[1];
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  } catch {
    return null;
  }
};

const loadDownloads = (): DownloadItem[] => {
  try {
    const saved = localStorage.getItem("vidmatealt-downloads");
    const items = saved ? JSON.parse(saved) as DownloadItem[] : [];
    return items.map((item) => {
      if (item.state === "downloading") return { ...item, state: "cancelled", message: "Download was interrupted when the app closed" };
      if (item.message?.includes("reading 'invoke'")) return { ...item, message: "Downloads require the installed VidmateAlt app. Open the desktop app to download." };
      return item;
    });
  } catch {
    return [];
  }
};

function App() {
  const [url, setUrl] = useState("");
  const [videoUrl, setVideoUrl] = useState("");
  const [googleClientId, setGoogleClientId] = useState(savedGoogleClientId);
  const [theme, setTheme] = useState<"light" | "dark">(savedTheme);
  const [downloads, setDownloads] = useState<DownloadItem[]>(loadDownloads);
  const [videos, setVideos] = useState<VideoItem[]>(featuredVideos);
  const [youtubeConnected, setYoutubeConnected] = useState(false);
  const [youtubeSubscriptions, setYoutubeSubscriptions] = useState(0);
  const [connectingYoutube, setConnectingYoutube] = useState(false);
  const [showGoogleSetup, setShowGoogleSetup] = useState(false);
  const [showAddVideo, setShowAddVideo] = useState(false);
  const [playingVideoId, setPlayingVideoId] = useState<string | null>(null);
  const [downloadDialogTitle, setDownloadDialogTitle] = useState<string | null>(null);
  const [cardDownloadUrl, setCardDownloadUrl] = useState("");
  const [downloadDialogError, setDownloadDialogError] = useState("");
  const [appView, setAppView] = useState<AppView>("videos");
  const [activeView, setActiveView] = useState<"queue" | "library">("queue");
  const [filter, setFilter] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = Promise.all([
      listen<{ id: string; received: number; total: number | null }>("download-progress", ({ payload }) => {
        setDownloads((items) => items.map((item) => item.id === payload.id ? { ...item, received: payload.received, total: payload.total } : item));
      }),
      listen<{ id: string; filename: string; path: string }>("download-finished", ({ payload }) => {
        setDownloads((items) => items.map((item) => item.id === payload.id ? { ...item, state: "complete", name: payload.filename, path: payload.path, total: item.total ?? item.received } : item));
      }),
      listen<{ id: string; message: string }>("download-failed", ({ payload }) => {
        setDownloads((items) => items.map((item) => item.id === payload.id ? { ...item, state: payload.message === "Download cancelled" ? "cancelled" : "failed", message: payload.message } : item));
      }),
    ]);
    return () => { void unlisten.then((dispose) => dispose.forEach((stop) => stop())); };
  }, []);

  useEffect(() => {
    localStorage.setItem("vidmatealt-downloads", JSON.stringify(downloads));
  }, [downloads]);

  useEffect(() => {
    localStorage.setItem("vidmatealt-google-client-id", googleClientId);
  }, [googleClientId]);

  useEffect(() => {
    localStorage.setItem("vidmatealt-theme", theme);
  }, [theme]);

  const visibleDownloads = useMemo(() => downloads.filter((item) => {
    const inView = activeView === "queue" ? item.state !== "complete" : item.state === "complete";
    return inView && item.name.toLowerCase().includes(filter.toLowerCase());
  }), [downloads, activeView, filter]);

  async function startDownload(downloadUrl: string) {
    if (!isTauri()) {
      throw new Error("Downloads require the installed VidmateAlt app. Open the desktop app to download.");
    }
    const trimmedUrl = downloadUrl.trim();
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(trimmedUrl);
    } catch {
      throw new Error("Enter a valid URL.");
    }
    if (!(["http:", "https:"].includes(parsedUrl.protocol))) {
      throw new Error("Only HTTP and HTTPS links are supported.");
    }
    const id = crypto.randomUUID();
    const item: DownloadItem = { id, url: trimmedUrl, name: itemName(trimmedUrl), state: "downloading", received: 0, total: null };
    setDownloads((items) => [item, ...items]);
    try {
      await invoke("start_download", { id, url: trimmedUrl });
    } catch (error) {
      setDownloads((items) => items.map((download) => download.id === id ? { ...download, state: "failed", message: String(error) } : download));
    }
  }

  async function addDownload(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      await startDownload(url);
      setUrl("");
      setNotice("");
    } catch (error) {
      setNotice(String(error));
    }
  }

  async function addCardDownload(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setDownloadDialogError("");
    try {
      await startDownload(cardDownloadUrl);
      setCardDownloadUrl("");
      setDownloadDialogTitle(null);
      setAppView("downloads");
      setActiveView("queue");
    } catch (error) {
      setDownloadDialogError(error instanceof Error ? error.message : String(error));
    }
  }

  function closeDownloadDialog() {
    setDownloadDialogTitle(null);
    setCardDownloadUrl("");
    setDownloadDialogError("");
  }

  async function cancelDownload(id: string) {
    if (!isTauri()) {
      setNotice("Cancel downloads in the installed VidmateAlt desktop app.");
      return;
    }
    await invoke("cancel_download", { id });
  }

  function addVideo(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const id = youtubeVideoId(videoUrl);
    if (!id) {
      setNotice("Enter a YouTube video, Shorts, or youtu.be link.");
      return;
    }
    setVideos((items) => items.some((item) => item.id === id) ? items : [{ id, title: "Added video", detail: "YouTube embed" }, ...items]);
    setVideoUrl("");
    setNotice("");
  }

  async function connectYoutube() {
    if (!googleClientId.trim()) {
      setShowGoogleSetup(true);
      setNotice("Add your Google OAuth desktop client ID to continue.");
      return;
    }
    if (!isTauri()) {
      setNotice("Google account linking requires the installed VidmateAlt desktop app.");
      return;
    }

    setConnectingYoutube(true);
    setNotice("");
    try {
      const redirectUri = await invoke<string>("prepare_youtube_auth");
      const stateBytes = crypto.getRandomValues(new Uint8Array(32));
      const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
      const challenge = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
      const state = base64Url(stateBytes);
      const authorization = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      authorization.search = new URLSearchParams({
        client_id: googleClientId.trim(),
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "https://www.googleapis.com/auth/youtube.readonly",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
      }).toString();
      await openUrl(authorization.toString());
      const feed = await invoke<YoutubeFeed>("complete_youtube_auth", {
        clientId: googleClientId.trim(), redirectUri, expectedState: state, codeVerifier: verifier,
      });
      setVideos(feed.videos);
      setYoutubeSubscriptions(feed.subscriptions);
      setYoutubeConnected(true);
    } catch (error) {
      setNotice(String(error));
    } finally {
      setConnectingYoutube(false);
    }
  }

  function disconnectYoutube() {
    setYoutubeConnected(false);
    setYoutubeSubscriptions(0);
    setVideos(featuredVideos);
    setPlayingVideoId(null);
    setNotice("YouTube disconnected. No account token was saved on this device.");
  }

  function openDownloads(view: "queue" | "library") {
    setAppView("downloads");
    setActiveView(view);
  }

  const activeCount = downloads.filter((item) => item.state === "downloading").length;
  const completeCount = downloads.filter((item) => item.state === "complete").length;

  return (
    <main className="app-shell" data-theme={theme}>
      <aside className="rail">
        <div className="brand-mark"><ArrowDownToLine size={19} strokeWidth={2.5} /></div>
        <div className="rail-rule" />
        <button className={`rail-button ${appView === "videos" ? "active" : ""}`} title="Videos" onClick={() => setAppView("videos")}><Compass size={19} /></button>
        <button className={`rail-button ${appView === "downloads" && activeView === "queue" ? "active" : ""}`} title="Downloads" onClick={() => openDownloads("queue")}><Download size={19} /></button>
        <button className={`rail-button ${appView === "downloads" && activeView === "library" ? "active" : ""}`} title="Library" onClick={() => openDownloads("library")}><FolderOpen size={19} /></button>
        <button className="rail-button" title="Settings" onClick={() => setNotice("Downloads are saved in your Downloads folder.")}><Settings2 size={19} /></button>
        <div className="rail-bottom"><button className="rail-button" title="About VidmateAlt" onClick={() => setNotice("VidmateAlt downloads videos from YouTube, Instagram, and direct file links.")}><CircleHelp size={19} /></button></div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="topbar-title"><span className="eyebrow">PERSONAL MEDIA LIBRARY</span><h1>Vidmate<span>Alt</span></h1></div>
          <div className="topbar-right"><span className="local-status"><i /> Local downloads</span><button className="icon-button theme-toggle" title={`Switch to ${theme === "light" ? "dark" : "light"} mode`} aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`} onClick={() => setTheme((current) => current === "light" ? "dark" : "light")}>{theme === "light" ? <Moon size={18} /> : <Sun size={18} />}</button><button className="icon-button settings-toggle" title="Settings" onClick={() => setNotice("Downloads are saved in your Downloads folder.")}><Settings2 size={18} /></button></div>
        </header>

        <div className="content">
          {appView === "videos" ? (
            <>
              <section className="watch-heading">
                <div><p className="eyebrow">YOUR VIDEO SPACE</p><h2>{youtubeConnected ? "Fresh from your people." : "Find your next watch."}</h2><p>{youtubeConnected ? `New uploads from ${youtubeSubscriptions} channels you follow.` : "Good videos, all in one place."}</p></div>
                <div className="watch-account">
                  {youtubeConnected ? <><span className="connected-label"><i /> Connected</span><button className="account-icon-button" onClick={disconnectYoutube} title="Disconnect YouTube" aria-label="Disconnect YouTube"><UserRound size={17} /></button></> : <button className="connect-button" onClick={() => showGoogleSetup ? void connectYoutube() : setShowGoogleSetup(true)} disabled={connectingYoutube}>{connectingYoutube ? <><LoaderCircle size={15} className="spin" /> Connecting</> : <><UserRound size={15} /> Connect YouTube</>}</button>}
                </div>
              </section>
              {!youtubeConnected && showGoogleSetup && <section className="connect-panel"><div className="connect-panel-copy"><strong>Connect your channel</strong><span>Use your Google Cloud desktop OAuth client ID.</span></div><label className="google-client-field"><input value={googleClientId} onChange={(event) => setGoogleClientId(event.currentTarget.value)} placeholder="Google OAuth client ID" autoComplete="off" aria-label="Google OAuth client ID" /></label><button className="connect-submit" onClick={() => void connectYoutube()} disabled={connectingYoutube || !googleClientId.trim()}>{connectingYoutube ? "Connecting..." : "Continue"}</button><button className="connect-dismiss" onClick={() => setShowGoogleSetup(false)} aria-label="Close connection setup"><X size={16} /></button></section>}
              {!youtubeConnected && <section className="featured-strip"><span className="featured-label">A FEW TO GET STARTED</span><span>Connect YouTube to see recent uploads from channels you follow.</span></section>}
              <section className="video-shelf-heading"><div><h3>{youtubeConnected ? "Latest uploads" : "Picked for you"}</h3><span>{videos.length} videos</span></div><button className="add-video-toggle" onClick={() => setShowAddVideo((open) => !open)}><Plus size={16} /><span>Add a video</span></button></section>
              {showAddVideo && <form className="video-url-form" onSubmit={addVideo}>
                <div className="url-field"><Link2 size={18} /><input value={videoUrl} onChange={(event) => setVideoUrl(event.currentTarget.value)} placeholder="Paste a YouTube video link" aria-label="YouTube video URL" type="url" required /></div>
                <button className="add-button" type="submit" disabled={!videoUrl.trim()}><Plus size={17} /> Add video</button>
              </form>}
              {notice && <div className="notice">{notice}<button onClick={() => setNotice("")} aria-label="Dismiss"><X size={14} /></button></div>}
              <section className="video-grid" aria-label="Videos">
                {videos.map((video) => (
                  <article className="video-card" key={video.id}>
                    <div className="video-frame">
                      {playingVideoId === video.id ? <iframe src={`https://www.youtube-nocookie.com/embed/${video.id}?autoplay=1&rel=0`} title={video.title} allow="autoplay; encrypted-media; picture-in-picture" referrerPolicy="strict-origin-when-cross-origin" allowFullScreen /> : <button className="video-cover" onClick={() => setPlayingVideoId(video.id)} aria-label={`Play ${video.title}`}><img src={video.thumbnail ?? `https://img.youtube.com/vi/${video.id}/hqdefault.jpg`} alt="" loading="lazy" /><span className="thumbnail-play"><Play size={18} fill="currentColor" /></span></button>}
                    </div>
                    <div className="video-caption"><div className="video-description"><span className="video-type">{youtubeConnected ? "FROM YOUR CHANNELS" : "FEATURED VIDEO"}</span><h3>{video.title}</h3><p>{youtubeConnected ? video.channel : video.detail}</p></div><div className="video-actions"><button className="video-play-button" onClick={() => setPlayingVideoId(video.id)}><Play size={13} fill="currentColor" /> Play</button><button className="video-download-button" onClick={() => { setDownloadDialogTitle(video.title); setDownloadDialogError(""); }} title={`Download an authorized direct file for ${video.title}`} aria-label={`Download ${video.title}`}><Download size={15} /></button></div></div>
                  </article>
                ))}
              </section>
              <p className="video-note">YouTube videos play in the YouTube player. Subscription uploads are available after connecting; the private Home recommendations feed is not exposed by YouTube’s API.</p>
            </>
          ) : (
            <>
          <section className="add-section">
            <div className="section-heading"><div><p className="eyebrow">ADD TO YOUR LIBRARY</p><h2>Bring a file in.</h2></div><span className="section-index">01 / INTAKE</span></div>
            <form className="url-form" onSubmit={addDownload}>
              <div className="url-field"><Link2 size={18} /><input value={url} onChange={(event) => setUrl(event.currentTarget.value)} placeholder="Paste a YouTube, Instagram, or direct file link" aria-label="Video or file URL" type="url" required /><button type="button" className="paste-button" onClick={async () => { try { setUrl(await navigator.clipboard.readText()); } catch { setNotice("Clipboard access is unavailable. Paste your link into the field."); } }}>Paste <ChevronDown size={13} /></button></div>
              <button className="add-button" type="submit" disabled={!url.trim()}><Plus size={17} /> Add link</button>
            </form>
            <div className="intake-foot"><span><i className="tiny-check"><Check size={10} /></i> YouTube, Instagram &amp; direct links</span><span>Files save to <strong>Downloads</strong></span></div>
                <p className="download-boundary">Paste a YouTube or Instagram link to download the actual video.</p>
            {notice && <div className="notice">{notice}<button onClick={() => setNotice("")} aria-label="Dismiss"><X size={14} /></button></div>}
          </section>

          <section className="downloads-section">
            <div className="list-heading"><div className="view-tabs" role="tablist" aria-label="Download views"><button role="tab" aria-selected={activeView === "queue"} className={activeView === "queue" ? "selected" : ""} onClick={() => setActiveView("queue")}>Queue <span>{activeCount}</span></button><button role="tab" aria-selected={activeView === "library"} className={activeView === "library" ? "selected" : ""} onClick={() => setActiveView("library")}>Library <span>{completeCount}</span></button></div><label className="search-box"><Search size={16} /><input value={filter} onChange={(event) => setFilter(event.currentTarget.value)} placeholder="Filter files" aria-label="Filter downloads" /></label></div>
            <div className="list-labels"><span>FILE</span><span>STATUS</span><span>SIZE</span><span /></div>
            {visibleDownloads.length === 0 ? (
              <div className="empty-state"><div className="empty-icon"><FileVideo2 size={22} /></div><p>{activeView === "queue" ? "Nothing in the queue" : "Your library is waiting"}</p><span>{activeView === "queue" ? "Add a direct file link above to start a download." : "Completed downloads will show up here."}</span></div>
            ) : (
              <div className="download-list">{visibleDownloads.map((item) => {
                const progress = item.total ? Math.min(100, Math.round(item.received / item.total * 100)) : 0;
                return <article className="download-row" key={item.id}>
                  <div className="file-cell"><div className={`file-icon ${item.state}`}><FileVideo2 size={18} /></div><div className="file-info"><strong title={item.name}>{item.name}</strong><span>{new URL(item.url).hostname}</span>{item.state === "downloading" && <div className="progress-track"><i style={{ width: `${progress}%` }} /></div>}{(item.state === "failed" || item.state === "cancelled") && <small>{item.message}</small>}</div></div>
                  <div className={`status-cell ${item.state}`}>{item.state === "downloading" ? <><LoaderCircle size={14} className="spin" /> Downloading</> : item.state === "complete" ? <><Check size={14} /> Complete</> : item.state === "cancelled" ? <><X size={14} /> Cancelled</> : <><X size={14} /> Failed</>}</div>
                  <span className="size-cell">{item.total ? readableSize(item.total) : item.received ? `${readableSize(item.received)} / —` : "—"}</span>
                  <div className="row-actions">{item.state === "downloading" && <button className="icon-button small" title="Cancel download" onClick={() => void cancelDownload(item.id)}><X size={15} /></button>}</div>
                </article>;
              })}</div>
            )}
          </section>
          <footer className="workspace-footer"><span><FolderOpen size={14} /> Downloads folder</span><span><Clock3 size={14} /> {downloads.length} {downloads.length === 1 ? "item" : "items"}</span><span className="footer-note">Only download files you have permission to save.</span></footer>
            </>
          )}
        </div>
      </section>

      {downloadDialogTitle && <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDownloadDialog(); }}>
        <section className="download-dialog" role="dialog" aria-modal="true" aria-labelledby="download-dialog-title">
          <header className="dialog-header"><div><p className="eyebrow">DIRECT FILE DOWNLOAD</p><h2 id="download-dialog-title">Download source</h2></div><button className="icon-button" onClick={closeDownloadDialog} aria-label="Close dialog"><X size={18} /></button></header>
          <p className="dialog-video-title">For: <strong>{downloadDialogTitle}</strong></p>
          <form onSubmit={(event) => void addCardDownload(event)}>
            <label className="dialog-url-label" htmlFor="card-download-url">Direct file URL</label>
            <div className="url-field"><Link2 size={17} /><input id="card-download-url" type="url" value={cardDownloadUrl} onChange={(event) => { setCardDownloadUrl(event.currentTarget.value); setDownloadDialogError(""); }} placeholder="https://example.com/video.mp4" autoFocus required /></div>
            <div className="format-choice"><span>File format</span><strong>Original file</strong></div>
            <p className="dialog-disclaimer">Use a YouTube, Instagram, or direct HTTP/HTTPS link you have permission to save.</p>
            {downloadDialogError && <p className="dialog-error" role="alert">{downloadDialogError}</p>}
            <div className="dialog-actions"><button type="button" className="dialog-cancel" onClick={closeDownloadDialog}>Cancel</button><button type="submit" className="dialog-submit" disabled={!cardDownloadUrl.trim()}><Download size={15} /> Start download</button></div>
          </form>
        </section>
      </div>}

      <nav className="mobile-nav" aria-label="Main navigation">
        <button className={appView === "videos" ? "selected" : ""} onClick={() => setAppView("videos")} aria-current={appView === "videos" ? "page" : undefined}><Compass size={19} /><span>Videos</span></button>
        <button className={appView === "downloads" && activeView === "queue" ? "selected" : ""} onClick={() => openDownloads("queue")} aria-current={appView === "downloads" && activeView === "queue" ? "page" : undefined}><Download size={19} /><span>Downloads</span></button>
        <button className={appView === "downloads" && activeView === "library" ? "selected" : ""} onClick={() => openDownloads("library")} aria-current={appView === "downloads" && activeView === "library" ? "page" : undefined}><FolderOpen size={19} /><span>Library</span></button>
      </nav>
    </main>
  );
}

export default App;
