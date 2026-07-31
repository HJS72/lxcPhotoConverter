export type StatusResponse = {
  queued_files: number;
  workers_alive: number;
  total_processed: number;
  total_failed: number;
  total_duplicates: number;
};

export type HistoryItem = {
  id: number;
  source_path: string;
  destination_path: string | null;
  extension: string;
  captured_at: string | null;
  status: string;
  error_message: string | null;
  created_at: string;
};

const readJson = async <T,>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}`);
  }
  return (await response.json()) as T;
};

export const fetchStatus = () => readJson<StatusResponse>("/api/status");
export const fetchHistory = () => readJson<HistoryItem[]>("/api/history?limit=50");
export const triggerScan = () => readJson<{ discovered: number; queued: number }>("/api/scan", { method: "POST" });
