use std::{collections::HashMap, net::TcpListener, path::PathBuf, sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex}};

use futures_util::{stream, StreamExt};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
struct DownloadManager {
    active: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[derive(Default)]
struct YoutubeAuthManager {
    listener: Mutex<Option<TcpListener>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct YoutubeVideo {
    id: String,
    title: String,
    channel: String,
    thumbnail: String,
    published_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct YoutubeFeed {
    videos: Vec<YoutubeVideo>,
    subscriptions: usize,
}

#[derive(Deserialize)]
struct YoutubeTokenResponse {
    access_token: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadUpdate {
    id: String,
    received: u64,
    total: Option<u64>,
    filename: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadFinished {
    id: String,
    filename: String,
    path: String,
}

#[derive(Clone, Serialize)]
struct DownloadFailure {
    id: String,
    message: String,
}

#[tauri::command]
fn start_download(
    app: AppHandle,
    manager: State<'_, DownloadManager>,
    id: String,
    url: String,
) -> Result<(), String> {
    let parsed = url::Url::parse(&url).map_err(|_| "Enter a valid direct file URL".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("Only direct HTTP or HTTPS file links are supported".to_string());
    }

    let filename = safe_filename(parsed.path_segments().and_then(|segments| segments.last()).unwrap_or("download"));
    let cancelled = Arc::new(AtomicBool::new(false));
    manager.active.lock().map_err(|_| "Download manager is unavailable".to_string())?.insert(id.clone(), cancelled.clone());

    tauri::async_runtime::spawn(async move {
        let result = download_file(&app, &id, &url, &filename, cancelled.clone()).await;
        if let Ok(mut active) = app.state::<DownloadManager>().active.lock() {
            active.remove(&id);
        }
        match result {
            Ok(path) => { let _ = app.emit("download-finished", DownloadFinished { id, filename, path: path.to_string_lossy().into_owned() }); }
            Err(message) => { let _ = app.emit("download-failed", DownloadFailure { id, message }); }
        }
    });
    Ok(())
}

#[tauri::command]
fn cancel_download(manager: State<'_, DownloadManager>, id: String) -> Result<(), String> {
    let active = manager.active.lock().map_err(|_| "Download manager is unavailable".to_string())?;
    if let Some(cancelled) = active.get(&id) {
        cancelled.store(true, Ordering::Relaxed);
    }
    Ok(())
}

async fn download_file(
    app: &AppHandle,
    id: &str,
    url: &str,
    filename: &str,
    cancelled: Arc<AtomicBool>,
) -> Result<PathBuf, String> {
    let response = reqwest::Client::new().get(url).send().await.map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Server responded with {}", response.status()));
    }

    let total = response.content_length();
    let directory = download_directory()?;
    tokio::fs::create_dir_all(&directory).await.map_err(|error| error.to_string())?;
    let path = unique_path(&directory, filename);
    let mut file = tokio::fs::File::create(&path).await.map_err(|error| error.to_string())?;
    let mut stream = response.bytes_stream();
    let mut received = 0_u64;

    while let Some(chunk) = stream.next().await {
        if cancelled.load(Ordering::Relaxed) {
            drop(file);
            let _ = tokio::fs::remove_file(&path).await;
            return Err("Download cancelled".to_string());
        }
        let chunk = chunk.map_err(|error| error.to_string())?;
        tokio::io::AsyncWriteExt::write_all(&mut file, &chunk).await.map_err(|error| error.to_string())?;
        received += chunk.len() as u64;
        let _ = app.emit("download-progress", DownloadUpdate { id: id.to_string(), received, total, filename: filename.to_string() });
    }

    if cancelled.load(Ordering::Relaxed) {
        drop(file);
        let _ = tokio::fs::remove_file(&path).await;
        return Err("Download cancelled".to_string());
    }
    tokio::io::AsyncWriteExt::flush(&mut file).await.map_err(|error| error.to_string())?;
    Ok(path)
}

fn download_directory() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or_else(|| "Could not locate your home directory".to_string())?;
    Ok(PathBuf::from(home).join("Downloads"))
}

fn safe_filename(candidate: &str) -> String {
    let cleaned: String = candidate.chars().filter(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_' )).collect();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." { "download".to_string() } else { cleaned }
}

fn unique_path(directory: &std::path::Path, filename: &str) -> PathBuf {
    let original = PathBuf::from(filename);
    let stem = original.file_stem().and_then(|value| value.to_str()).unwrap_or("download");
    let extension = original.extension().and_then(|value| value.to_str());
    let mut path = directory.join(filename);
    let mut suffix = 1_u32;
    while path.exists() {
        let next_name = match extension {
            Some(extension) => format!("{stem} ({suffix}).{extension}"),
            None => format!("{stem} ({suffix})"),
        };
        path = directory.join(next_name);
        suffix += 1;
    }
    path
}

#[tauri::command]
fn prepare_youtube_auth(auth: State<'_, YoutubeAuthManager>) -> Result<String, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|error| format!("Could not start sign-in callback: {error}"))?;
    listener.set_nonblocking(true).map_err(|error| error.to_string())?;
    let address = listener.local_addr().map_err(|error| error.to_string())?;
    let mut stored = auth.listener.lock().map_err(|_| "Sign-in is unavailable".to_string())?;
    *stored = Some(listener);
    Ok(format!("http://127.0.0.1:{}", address.port()))
}

#[tauri::command]
async fn complete_youtube_auth(
    auth: State<'_, YoutubeAuthManager>,
    client_id: String,
    redirect_uri: String,
    expected_state: String,
    code_verifier: String,
) -> Result<YoutubeFeed, String> {
    if client_id.trim().is_empty() {
        return Err("Add your Google OAuth desktop client ID first".to_string());
    }
    let listener = auth.listener.lock().map_err(|_| "Sign-in is unavailable".to_string())?.take()
        .ok_or_else(|| "Start YouTube sign-in again".to_string())?;
    let listener = tokio::net::TcpListener::from_std(listener).map_err(|error| error.to_string())?;
    let (mut socket, _) = tokio::time::timeout(std::time::Duration::from_secs(180), listener.accept())
        .await.map_err(|_| "YouTube sign-in timed out".to_string())?
        .map_err(|error| error.to_string())?;
    let mut request = vec![0_u8; 8192];
    let length = tokio::io::AsyncReadExt::read(&mut socket, &mut request).await.map_err(|error| error.to_string())?;
    let request = String::from_utf8_lossy(&request[..length]);
    let callback_path = request.lines().next().and_then(|line| line.split_whitespace().nth(1))
        .ok_or_else(|| "Invalid Google sign-in response".to_string())?;
    let callback = url::Url::parse(&format!("http://127.0.0.1{callback_path}"))
        .map_err(|_| "Invalid Google sign-in response".to_string())?;
    let code = callback.query_pairs().find(|(key, _)| key == "code").map(|(_, value)| value.into_owned());
    let returned_state = callback.query_pairs().find(|(key, _)| key == "state").map(|(_, value)| value.into_owned());
    let error = callback.query_pairs().find(|(key, _)| key == "error").map(|(_, value)| value.into_owned());
    let page = if returned_state.as_deref() != Some(expected_state.as_str()) {
        "Sign-in could not be verified. Return to VidmateAlt and try again."
    } else if error.is_some() {
        "YouTube sign-in was cancelled. You can close this tab."
    } else {
        "YouTube is connected. Return to VidmateAlt."
    };
    let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}", page.len(), page);
    let _ = tokio::io::AsyncWriteExt::write_all(&mut socket, response.as_bytes()).await;

    if returned_state.as_deref() != Some(expected_state.as_str()) {
        return Err("Google sign-in state did not match".to_string());
    }
    if error.is_some() {
        return Err("YouTube sign-in was cancelled".to_string());
    }
    let code = code.ok_or_else(|| "Google did not return an authorization code".to_string())?;

    let client = reqwest::Client::new();
    let token_response = client.post("https://oauth2.googleapis.com/token")
        .form(&[
            ("client_id", client_id.as_str()),
            ("code", code.as_str()),
            ("code_verifier", code_verifier.as_str()),
            ("grant_type", "authorization_code"),
            ("redirect_uri", redirect_uri.as_str()),
        ])
        .send().await.map_err(|error| error.to_string())?;
    if !token_response.status().is_success() {
        return Err(format!("Google token exchange failed: {}", token_response.status()));
    }
    let token: YoutubeTokenResponse = token_response.json().await.map_err(|error| error.to_string())?;
    fetch_youtube_subscriptions(&client, &token.access_token).await
}

async fn fetch_youtube_subscriptions(client: &reqwest::Client, access_token: &str) -> Result<YoutubeFeed, String> {
    let subscriptions_response = client.get("https://www.googleapis.com/youtube/v3/subscriptions")
        .bearer_auth(access_token)
        .query(&[("part", "snippet"), ("mine", "true"), ("maxResults", "50")])
        .send().await.map_err(|error| error.to_string())?;
    if !subscriptions_response.status().is_success() {
        return Err(format!("Could not read YouTube subscriptions: {}", subscriptions_response.status()));
    }
    let subscriptions: serde_json::Value = subscriptions_response.json().await.map_err(|error| error.to_string())?;
    let channel_ids: Vec<String> = subscriptions["items"].as_array().into_iter().flatten()
        .filter_map(|item| item["snippet"]["resourceId"]["channelId"].as_str().map(str::to_owned))
        .take(50).collect();
    let subscription_count = channel_ids.len();
    if channel_ids.is_empty() {
        return Ok(YoutubeFeed { videos: Vec::new(), subscriptions: 0 });
    }

    let channel_ids_query = channel_ids.join(",");
    let channels_response = client.get("https://www.googleapis.com/youtube/v3/channels")
        .bearer_auth(access_token)
        .query(&[("part", "contentDetails"), ("id", channel_ids_query.as_str())])
        .send().await.map_err(|error| error.to_string())?;
    if !channels_response.status().is_success() {
        return Err(format!("Could not load subscribed channels: {}", channels_response.status()));
    }
    let channels: serde_json::Value = channels_response.json().await.map_err(|error| error.to_string())?;
    let upload_lists: Vec<String> = channels["items"].as_array().into_iter().flatten()
        .filter_map(|channel| channel["contentDetails"]["relatedPlaylists"]["uploads"].as_str().map(str::to_owned))
        .collect();

    let requests = stream::iter(upload_lists.into_iter().map(|playlist_id| {
        let client = client.clone();
        let token = access_token.to_owned();
        async move {
            let response = client.get("https://www.googleapis.com/youtube/v3/playlistItems")
                .bearer_auth(token)
                .query(&[("part", "snippet"), ("playlistId", playlist_id.as_str()), ("maxResults", "3")])
                .send().await.map_err(|error| error.to_string())?;
            if !response.status().is_success() { return Err(format!("YouTube upload list failed: {}", response.status())); }
            let items: serde_json::Value = response.json().await.map_err(|error| error.to_string())?;
            let videos = items["items"].as_array().into_iter().flatten().filter_map(|item| {
                let snippet = &item["snippet"];
                let id = snippet["resourceId"]["videoId"].as_str()?.to_owned();
                let thumbnails = &snippet["thumbnails"];
                let thumbnail = ["high", "medium", "default"].iter()
                    .find_map(|key| thumbnails[*key]["url"].as_str())?.to_owned();
                Some(YoutubeVideo {
                    id,
                    title: snippet["title"].as_str().unwrap_or("Untitled video").to_owned(),
                    channel: snippet["channelTitle"].as_str().unwrap_or("YouTube channel").to_owned(),
                    thumbnail,
                    published_at: snippet["publishedAt"].as_str().unwrap_or("").to_owned(),
                })
            }).collect::<Vec<_>>();
            Ok::<_, String>(videos)
        }
    })).buffer_unordered(8).collect::<Vec<_>>().await;

    let mut videos: Vec<YoutubeVideo> = requests.into_iter().filter_map(Result::ok).flatten().collect();
    videos.sort_by(|left, right| right.published_at.cmp(&left.published_at));
    Ok(YoutubeFeed { videos, subscriptions: subscription_count })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let downloads = DownloadManager::default();
    let youtube_auth = YoutubeAuthManager::default();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(downloads)
        .manage(youtube_auth)
        .invoke_handler(tauri::generate_handler![start_download, cancel_download, prepare_youtube_auth, complete_youtube_auth])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
