import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  AppBar,
  Box,
  Button,
  Chip,
  CircularProgress,
  Container,
  CssBaseline,
  FormControlLabel,
  IconButton,
  Paper,
  Stack,
  Switch,
  Tab,
  Tabs,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Toolbar,
  Typography,
} from "@mui/material";
import DarkModeRoundedIcon from "@mui/icons-material/DarkModeRounded";
import LightModeRoundedIcon from "@mui/icons-material/LightModeRounded";
import AutorenewRoundedIcon from "@mui/icons-material/AutorenewRounded";
import { ThemeProvider } from "@mui/material/styles";

import {
  createWorkflow,
  deleteWorkflow,
  fetchHistory,
  fetchStatus,
  fetchWorkflows,
  HistoryItem,
  StatusResponse,
  triggerScan,
  updateWorkflow,
  WorkflowItem,
  WorkflowPayload,
} from "./api";
import { useAppTheme } from "./theme";

const formatTimestamp = (value: string | null) => {
  if (!value) {
    return "-";
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
};

export const App = () => {
  const { theme, mode, toggleMode } = useAppTheme();
  const [tab, setTab] = useState<"dashboard" | "admin">("dashboard");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editingWorkflowId, setEditingWorkflowId] = useState<number | null>(null);
  const [workflowForm, setWorkflowForm] = useState<WorkflowPayload>({
    name: "",
    source_path: "",
    destination_path: "",
    failed_path: "",
    enabled: true,
  });

  const stats = useMemo(
    () => [
      { label: "Queued", value: status?.queued_files ?? 0 },
      { label: "Workers", value: status?.workers_alive ?? 0 },
      { label: "Processed", value: status?.total_processed ?? 0 },
      { label: "Duplicates", value: status?.total_duplicates ?? 0 },
      { label: "Failed", value: status?.total_failed ?? 0 },
    ],
    [status]
  );

  const refreshDashboard = async () => {
    setRefreshing(true);
    try {
      const [statusData, historyData] = await Promise.all([fetchStatus(), fetchHistory()]);
      setStatus(statusData);
      setHistory(historyData);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const refreshWorkflows = async () => {
    try {
      const items = await fetchWorkflows();
      setWorkflows(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Workflow load failed");
    }
  };

  const runScan = async () => {
    try {
      await triggerScan();
      await refreshDashboard();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Scan failed");
    }
  };

  const resetWorkflowForm = () => {
    setEditingWorkflowId(null);
    setWorkflowForm({
      name: "",
      source_path: "",
      destination_path: "",
      failed_path: "",
      enabled: true,
    });
  };

  const submitWorkflow = async () => {
    try {
      if (editingWorkflowId === null) {
        await createWorkflow(workflowForm);
      } else {
        await updateWorkflow(editingWorkflowId, workflowForm);
      }
      await refreshWorkflows();
      await refreshDashboard();
      resetWorkflowForm();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Workflow save failed");
    }
  };

  const startEditWorkflow = (item: WorkflowItem) => {
    setEditingWorkflowId(item.id);
    setWorkflowForm({
      name: item.name,
      source_path: item.source_path,
      destination_path: item.destination_path,
      failed_path: item.failed_path,
      enabled: item.enabled,
    });
  };

  const removeWorkflow = async (workflowId: number) => {
    try {
      await deleteWorkflow(workflowId);
      await refreshWorkflows();
      await refreshDashboard();
      if (editingWorkflowId === workflowId) {
        resetWorkflowForm();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Workflow delete failed");
    }
  };

  useEffect(() => {
    void Promise.all([refreshDashboard(), refreshWorkflows()]);
    const timer = setInterval(() => {
      void refreshDashboard();
    }, 10000);
    return () => clearInterval(timer);
  }, []);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box
        sx={{
          minHeight: "100vh",
          background:
            mode === "dark"
              ? "radial-gradient(circle at 20% 20%, rgba(255,106,61,0.18), transparent 45%), linear-gradient(145deg, #0d0d0d, #1e1e1e 50%, #111)"
              : "radial-gradient(circle at 15% 15%, rgba(219,75,31,0.2), transparent 40%), linear-gradient(135deg, #f8f1e9, #fffdf9 60%, #efe8de)",
          py: 4,
        }}
      >
        <Container maxWidth="lg">
          <AppBar position="static" color="transparent" elevation={0} sx={{ mb: 3 }}>
            <Toolbar disableGutters sx={{ justifyContent: "space-between" }}>
              <Box>
                <Typography variant="h4">lxcPhotoConverter</Typography>
                <Typography variant="body2" color="text.secondary">
                  Automated media ingest for Proxmox LXC
                </Typography>
              </Box>
              <Stack direction="row" spacing={1}>
                {tab === "dashboard" && (
                  <Button
                    variant="contained"
                    startIcon={<AutorenewRoundedIcon />}
                    onClick={runScan}
                    disabled={refreshing}
                  >
                    Scan Now
                  </Button>
                )}
                <IconButton onClick={toggleMode} color="primary">
                  {mode === "dark" ? <LightModeRoundedIcon /> : <DarkModeRoundedIcon />}
                </IconButton>
              </Stack>
            </Toolbar>
          </AppBar>

          <Paper sx={{ mb: 2, border: "1px solid", borderColor: "divider" }}>
            <Tabs
              value={tab}
              onChange={(_, value: "dashboard" | "admin") => setTab(value)}
              textColor="primary"
              indicatorColor="primary"
            >
              <Tab value="dashboard" label="Dashboard" />
              <Tab value="admin" label="Admin Workflows" />
            </Tabs>
          </Paper>

          {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

          {loading ? (
            <Box sx={{ display: "grid", placeItems: "center", py: 10 }}>
              <CircularProgress />
            </Box>
          ) : tab === "admin" ? (
            <Stack spacing={3}>
              <Paper sx={{ p: 2, border: "1px solid", borderColor: "divider" }}>
                <Typography variant="h6" sx={{ mb: 2 }}>
                  {editingWorkflowId === null ? "Create Workflow" : `Edit Workflow #${editingWorkflowId}`}
                </Typography>
                <Stack spacing={2}>
                  <TextField
                    label="Workflow Name"
                    value={workflowForm.name}
                    onChange={(event) => setWorkflowForm((prev) => ({ ...prev, name: event.target.value }))}
                    fullWidth
                  />
                  <TextField
                    label="Source Path"
                    value={workflowForm.source_path}
                    onChange={(event) => setWorkflowForm((prev) => ({ ...prev, source_path: event.target.value }))}
                    fullWidth
                  />
                  <TextField
                    label="Destination Path"
                    value={workflowForm.destination_path}
                    onChange={(event) => setWorkflowForm((prev) => ({ ...prev, destination_path: event.target.value }))}
                    fullWidth
                  />
                  <TextField
                    label="Failed Path"
                    value={workflowForm.failed_path}
                    onChange={(event) => setWorkflowForm((prev) => ({ ...prev, failed_path: event.target.value }))}
                    fullWidth
                  />
                  <FormControlLabel
                    control={
                      <Switch
                        checked={workflowForm.enabled}
                        onChange={(event) =>
                          setWorkflowForm((prev) => ({ ...prev, enabled: event.target.checked }))
                        }
                      />
                    }
                    label="Enabled"
                  />
                  <Stack direction="row" spacing={1}>
                    <Button
                      variant="contained"
                      onClick={submitWorkflow}
                      disabled={
                        !workflowForm.name.trim() ||
                        !workflowForm.source_path.trim() ||
                        !workflowForm.destination_path.trim() ||
                        !workflowForm.failed_path.trim()
                      }
                    >
                      {editingWorkflowId === null ? "Create" : "Save"}
                    </Button>
                    <Button variant="outlined" onClick={resetWorkflowForm}>
                      Clear
                    </Button>
                  </Stack>
                </Stack>
              </Paper>

              <Paper sx={{ p: 2, border: "1px solid", borderColor: "divider" }}>
                <Typography variant="h6" sx={{ mb: 1 }}>
                  Configured Workflows
                </Typography>
                <TableContainer>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>Name</TableCell>
                        <TableCell>Source</TableCell>
                        <TableCell>Destination</TableCell>
                        <TableCell>Failed</TableCell>
                        <TableCell>Status</TableCell>
                        <TableCell align="right">Actions</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {workflows.map((item) => (
                        <TableRow key={item.id} hover>
                          <TableCell>{item.name}</TableCell>
                          <TableCell sx={{ maxWidth: 160, wordBreak: "break-all" }}>{item.source_path}</TableCell>
                          <TableCell sx={{ maxWidth: 160, wordBreak: "break-all" }}>{item.destination_path}</TableCell>
                          <TableCell sx={{ maxWidth: 160, wordBreak: "break-all" }}>{item.failed_path}</TableCell>
                          <TableCell>
                            <Chip size="small" color={item.enabled ? "success" : "default"} label={item.enabled ? "enabled" : "disabled"} />
                          </TableCell>
                          <TableCell align="right">
                            <Stack direction="row" spacing={1} justifyContent="flex-end">
                              <Button size="small" onClick={() => startEditWorkflow(item)}>
                                Edit
                              </Button>
                              <Button size="small" color="error" onClick={() => removeWorkflow(item.id)}>
                                Delete
                              </Button>
                            </Stack>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              </Paper>
            </Stack>
          ) : (
            <Stack spacing={3}>
              <Box
                sx={{
                  display: "grid",
                  gap: 2,
                  gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
                }}
              >
                {stats.map((item) => (
                  <Paper
                    key={item.label}
                    sx={{
                      p: 2,
                      border: "1px solid",
                      borderColor: "divider",
                      backdropFilter: "blur(8px)",
                    }}
                  >
                    <Typography variant="body2" color="text.secondary">
                      {item.label}
                    </Typography>
                    <Typography variant="h5" sx={{ fontWeight: 700 }}>
                      {item.value}
                    </Typography>
                  </Paper>
                ))}
              </Box>

              <Paper sx={{ p: 2, border: "1px solid", borderColor: "divider" }}>
                <Typography variant="h6" sx={{ mb: 1 }}>
                  Processing History
                </Typography>
                <TableContainer>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>Time</TableCell>
                        <TableCell>Source</TableCell>
                        <TableCell>Destination</TableCell>
                        <TableCell>Status</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {history.map((row) => (
                        <TableRow key={row.id} hover>
                          <TableCell>{formatTimestamp(row.created_at)}</TableCell>
                          <TableCell sx={{ maxWidth: 220, wordBreak: "break-all" }}>{row.source_path}</TableCell>
                          <TableCell sx={{ maxWidth: 220, wordBreak: "break-all" }}>
                            {row.destination_path ?? "-"}
                          </TableCell>
                          <TableCell>
                            <Chip
                              size="small"
                              label={row.status}
                              color={
                                row.status === "processed"
                                  ? "success"
                                  : row.status === "duplicate"
                                    ? "warning"
                                    : row.status === "failed"
                                      ? "error"
                                      : "default"
                              }
                            />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              </Paper>
            </Stack>
          )}
        </Container>
      </Box>
    </ThemeProvider>
  );
};
