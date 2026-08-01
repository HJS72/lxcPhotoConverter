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

export type WorkflowItem = {
  id: number;
  name: string;
  source_path: string;
  destination_path: string;
  failed_path: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type WorkflowPayload = {
  name: string;
  source_path: string;
  destination_path: string;
  failed_path: string;
  enabled: boolean;
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
export const fetchWorkflows = () => readJson<WorkflowItem[]>("/api/workflows");
export const createWorkflow = (payload: WorkflowPayload) =>
  readJson<WorkflowItem>("/api/workflows", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
export const updateWorkflow = (workflowId: number, payload: WorkflowPayload) =>
  readJson<WorkflowItem>(`/api/workflows/${workflowId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
export const deleteWorkflow = (workflowId: number) =>
  readJson<{ status: string }>(`/api/workflows/${workflowId}`, {
    method: "DELETE",
  });
