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
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  Paper,
  Stack,
  Snackbar,
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
  MenuItem,
} from "@mui/material";
import DarkModeRoundedIcon from "@mui/icons-material/DarkModeRounded";
import LightModeRoundedIcon from "@mui/icons-material/LightModeRounded";
import AutorenewRoundedIcon from "@mui/icons-material/AutorenewRounded";
import { ThemeProvider } from "@mui/material/styles";

import {
  checkNetworkDrive,
  cloneNetworkDrive,
  createWorkflow,
  createNetworkDrive,
  deleteNetworkDrive,
  deleteWorkflow,
  fetchHistory,
  fetchNetworkDrives,
  fetchStatus,
  fetchWorkflows,
  HistoryItem,
  NetworkDriveItem,
  NetworkDrivePayload,
  resetStats,
  StatusResponse,
  startScanSchedule,
  stopScanSchedule,
  triggerScan,
  updateScanInterval,
  updateNetworkDrive,
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
  const [networkDrives, setNetworkDrives] = useState<NetworkDriveItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [scanIntervalInput, setScanIntervalInput] = useState("120");
  const [scanIntervalDirty, setScanIntervalDirty] = useState(false);
  const [editingWorkflowId, setEditingWorkflowId] = useState<number | null>(null);
  const [overwriteConfirmOpen, setOverwriteConfirmOpen] = useState(false);
  const [overwriteTarget, setOverwriteTarget] = useState<WorkflowItem | null>(null);
  const [networkDialogOpen, setNetworkDialogOpen] = useState(false);
  const [editingDriveId, setEditingDriveId] = useState<number | null>(null);
  const [networkDriveForm, setNetworkDriveForm] = useState<NetworkDrivePayload>({
    name: "",
    smb_path: "",
    mount_path: "",
    username: "",
    password: "",
    enabled: true,
  });
  const [workflowForm, setWorkflowForm] = useState<WorkflowPayload>({
    name: "",
    source_path: "",
    destination_path: "",
    failed_path: "",
    allowed_extensions: "",
    enabled: true,
  });
  const [driveOverwriteConfirmOpen, setDriveOverwriteConfirmOpen] = useState(false);
  const [driveOverwriteTarget, setDriveOverwriteTarget] = useState<NetworkDriveItem | null>(null);

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

  const workflowPathOptions = useMemo(() => {
    const options = networkDrives
      .filter((drive) => Boolean(drive.mount_path && drive.mount_path.trim()))
      .map((drive) => ({
        value: (drive.mount_path ?? "").trim(),
        label: `${drive.name} (${(drive.mount_path ?? "").trim()})`,
      }));

    const seen = new Set<string>();
    return options.filter((option) => {
      if (!option.value || seen.has(option.value)) {
        return false;
      }
      seen.add(option.value);
      return true;
    });
  }, [networkDrives]);

  const ensureCurrentPathOption = (value: string) => {
    const normalized = value.trim();
    if (!normalized) {
      return workflowPathOptions;
    }
    if (workflowPathOptions.some((option) => option.value === normalized)) {
      return workflowPathOptions;
    }
    return [{ value: normalized, label: `Custom (${normalized})` }, ...workflowPathOptions];
  };

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

  const refreshNetworkDrives = async () => {
    try {
      const items = await fetchNetworkDrives();
      setNetworkDrives(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network drive load failed");
    }
  };

  const runScan = async () => {
    try {
      const result = await triggerScan();
      await refreshDashboard();
      setNotice(`Scan complete: discovered ${result.discovered}, queued ${result.queued}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Scan failed");
    }
  };

  const resetDashboardStats = async () => {
    try {
      const result = await resetStats();
      await refreshDashboard();
      setNotice(`Stats reset complete: removed ${result.deleted_rows} history rows.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reset stats failed");
    }
  };

  const toggleScanSchedule = async () => {
    try {
      const schedule = status?.scan_schedule_enabled ? await stopScanSchedule() : await startScanSchedule();
      await refreshDashboard();
      setNotice(schedule.enabled ? "Scan schedule started." : "Scan schedule stopped.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Scan schedule toggle failed");
    }
  };

  const applyScanInterval = async () => {
    const parsed = Number.parseInt(scanIntervalInput, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      setError("Scan interval must be a positive integer (seconds).");
      return;
    }
    try {
      const schedule = await updateScanInterval(parsed);
      await refreshDashboard();
      setScanIntervalInput(String(schedule.interval_seconds));
      setScanIntervalDirty(false);
      setNotice(`Scan interval updated to ${schedule.interval_seconds}s.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update scan interval failed");
    }
  };

  const resetWorkflowForm = () => {
    setEditingWorkflowId(null);
    setWorkflowForm({
      name: "",
      source_path: "",
      destination_path: "",
      failed_path: "",
      allowed_extensions: "",
      enabled: true,
    });
  };

  const submitWorkflow = async () => {
    try {
      if (editingWorkflowId === null) {
        await createWorkflow(workflowForm);
        setNotice("Workflow created.");
      } else {
        const editedWorkflow = workflows.find((item) => item.id === editingWorkflowId) ?? null;
        const nameChanged = editedWorkflow !== null && editedWorkflow.name !== workflowForm.name;
        const overwriteTarget =
          nameChanged
            ? workflows.find((item) => item.id !== editingWorkflowId && item.name === workflowForm.name) ?? null
            : null;

        if (overwriteTarget !== null) {
          setOverwriteTarget(overwriteTarget);
          setOverwriteConfirmOpen(true);
          return;
        } else {
          await updateWorkflow(editingWorkflowId, workflowForm);
          setNotice("Workflow saved.");
        }
      }
      await refreshWorkflows();
      await refreshDashboard();
      resetWorkflowForm();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Workflow save failed");
    }
  };

  const confirmOverwriteWorkflow = async () => {
    if (editingWorkflowId === null || overwriteTarget === null) {
      setOverwriteConfirmOpen(false);
      setOverwriteTarget(null);
      return;
    }
    try {
      await deleteWorkflow(overwriteTarget.id);
      await updateWorkflow(editingWorkflowId, workflowForm);
      await refreshWorkflows();
      await refreshDashboard();
      setNotice(`Workflow '${overwriteTarget.name}' overwritten.`);
      setOverwriteConfirmOpen(false);
      setOverwriteTarget(null);
      resetWorkflowForm();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Workflow overwrite failed");
    }
  };

  const saveWorkflowAsNew = async () => {
    try {
      await createWorkflow(workflowForm);
      await refreshWorkflows();
      await refreshDashboard();
      setNotice("Workflow created (Save As).");
      resetWorkflowForm();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Workflow Save As failed");
    }
  };

  const startEditWorkflow = (item: WorkflowItem) => {
    setEditingWorkflowId(item.id);
    setWorkflowForm({
      name: item.name,
      source_path: item.source_path,
      destination_path: item.destination_path,
      failed_path: item.failed_path,
      allowed_extensions: item.allowed_extensions ?? "",
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

  const resetDriveForm = () => {
    setEditingDriveId(null);
    setNetworkDriveForm({
      name: "",
      smb_path: "",
      mount_path: "",
      username: "",
      password: "",
      enabled: true,
    });
  };

  const closeDriveDialog = () => {
    setNetworkDialogOpen(false);
    resetDriveForm();
  };

  const openCreateDriveDialog = () => {
    resetDriveForm();
    setNetworkDialogOpen(true);
  };

  const openEditDriveDialog = (drive: NetworkDriveItem) => {
    setEditingDriveId(drive.id);
    setNetworkDriveForm({
      name: drive.name,
      smb_path: drive.smb_path,
      mount_path: drive.mount_path ?? "",
      username: drive.username,
      password: "",
      enabled: drive.enabled,
    });
    setNetworkDialogOpen(true);
  };

  const submitDrive = async () => {
    try {
      if (editingDriveId === null) {
        await createNetworkDrive(networkDriveForm);
        setError(null);
        setNotice("Network drive created.");
      } else {
        const editedDrive = networkDrives.find((item) => item.id === editingDriveId) ?? null;
        const nameChanged = editedDrive !== null && editedDrive.name !== networkDriveForm.name;
        const overwriteExisting =
          nameChanged
            ? networkDrives.find((item) => item.id !== editingDriveId && item.name === networkDriveForm.name) ?? null
            : null;

        if (overwriteExisting !== null) {
          setDriveOverwriteTarget(overwriteExisting);
          setDriveOverwriteConfirmOpen(true);
          return;
        }

        await updateNetworkDrive(editingDriveId, networkDriveForm);
        setError(null);
        setNotice("Network drive saved.");
      }
      await refreshNetworkDrives();
      closeDriveDialog();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network drive save failed");
    }
  };

  const saveDriveAsNew = async () => {
    if (editingDriveId === null) {
      setError("Save As is only available while editing an existing network drive.");
      return;
    }

    const payload = {
      ...networkDriveForm,
      password: networkDriveForm.password.trim() ? networkDriveForm.password : undefined,
    };

    try {
      await cloneNetworkDrive(editingDriveId, payload);
      await refreshNetworkDrives();
      setError(null);
      setNotice("Network drive created (Save As).");
      closeDriveDialog();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network drive Save As failed");
    }
  };

  const confirmOverwriteDrive = async () => {
    if (editingDriveId === null || driveOverwriteTarget === null) {
      setDriveOverwriteConfirmOpen(false);
      setDriveOverwriteTarget(null);
      return;
    }
    try {
      await deleteNetworkDrive(driveOverwriteTarget.id);
      await updateNetworkDrive(editingDriveId, networkDriveForm);
      await refreshNetworkDrives();
      setError(null);
      setNotice(`Network drive '${driveOverwriteTarget.name}' overwritten.`);
      setDriveOverwriteConfirmOpen(false);
      setDriveOverwriteTarget(null);
      closeDriveDialog();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network drive overwrite failed");
    }
  };

  const removeDrive = async (driveId: number) => {
    try {
      await deleteNetworkDrive(driveId);
      await refreshNetworkDrives();
      setError(null);
      setNotice("Network drive deleted.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network drive delete failed");
    }
  };

  const checkDrive = async (driveId: number) => {
    try {
      await checkNetworkDrive(driveId);
      await refreshNetworkDrives();
      setError(null);
      setNotice("Network drive check finished.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection check failed");
    }
  };

  useEffect(() => {
    void Promise.all([refreshDashboard(), refreshWorkflows(), refreshNetworkDrives()]);
    const timer = setInterval(() => {
      void refreshDashboard();
    }, 10000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!scanIntervalDirty && status) {
      setScanIntervalInput(String(status.scan_interval_seconds));
    }
  }, [scanIntervalDirty, status]);

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
                  <>
                    <Button
                      variant="outlined"
                      color={status?.scan_schedule_enabled ? "warning" : "success"}
                      onClick={toggleScanSchedule}
                      disabled={refreshing}
                    >
                      {status?.scan_schedule_enabled ? "Stop Schedule" : "Start Schedule"}
                    </Button>
                    <Button
                      variant="outlined"
                      color="warning"
                      onClick={resetDashboardStats}
                      disabled={refreshing}
                    >
                      Reset Stats
                    </Button>
                    <Button
                      variant="contained"
                      startIcon={<AutorenewRoundedIcon />}
                      onClick={runScan}
                      disabled={refreshing}
                    >
                      Scan Now
                    </Button>
                  </>
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
                    select
                    value={workflowForm.source_path}
                    onChange={(event) => setWorkflowForm((prev) => ({ ...prev, source_path: event.target.value }))}
                    helperText="Choose configured network drive mount path"
                    fullWidth
                  >
                    <MenuItem value="">Select source path</MenuItem>
                    {ensureCurrentPathOption(workflowForm.source_path).map((option) => (
                      <MenuItem key={`source-${option.value}`} value={option.value}>
                        {option.label}
                      </MenuItem>
                    ))}
                  </TextField>
                  <TextField
                    label="Destination Path"
                    select
                    value={workflowForm.destination_path}
                    onChange={(event) => setWorkflowForm((prev) => ({ ...prev, destination_path: event.target.value }))}
                    helperText="Choose configured network drive mount path"
                    fullWidth
                  >
                    <MenuItem value="">Select destination path</MenuItem>
                    {ensureCurrentPathOption(workflowForm.destination_path).map((option) => (
                      <MenuItem key={`destination-${option.value}`} value={option.value}>
                        {option.label}
                      </MenuItem>
                    ))}
                  </TextField>
                  <TextField
                    label="Failed Path"
                    select
                    value={workflowForm.failed_path}
                    onChange={(event) => setWorkflowForm((prev) => ({ ...prev, failed_path: event.target.value }))}
                    helperText="Choose configured network drive mount path"
                    fullWidth
                  >
                    <MenuItem value="">Select failed path</MenuItem>
                    {ensureCurrentPathOption(workflowForm.failed_path).map((option) => (
                      <MenuItem key={`failed-${option.value}`} value={option.value}>
                        {option.label}
                      </MenuItem>
                    ))}
                  </TextField>
                  <TextField
                    label="Filetypes (comma-separated, optional)"
                    value={workflowForm.allowed_extensions}
                    onChange={(event) =>
                      setWorkflowForm((prev) => ({ ...prev, allowed_extensions: event.target.value }))
                    }
                    placeholder=".jpg,.jpeg,.heic,.mp4"
                    fullWidth
                  />
                  <Typography variant="body2" color="text.secondary">
                    Filename pattern is fixed: IMG_YYYYMMDD_HHMMSS.ext
                  </Typography>
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
                    {editingWorkflowId !== null && (
                      <Button
                        variant="outlined"
                        onClick={saveWorkflowAsNew}
                        disabled={
                          !workflowForm.name.trim() ||
                          !workflowForm.source_path.trim() ||
                          !workflowForm.destination_path.trim() ||
                          !workflowForm.failed_path.trim()
                        }
                      >
                        Save As
                      </Button>
                    )}
                    <Button variant="outlined" onClick={resetWorkflowForm}>
                      Clear
                    </Button>
                  </Stack>
                </Stack>
              </Paper>

              <Paper sx={{ p: 2, border: "1px solid", borderColor: "divider" }}>
                <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
                  <Typography variant="h6">Network Drives</Typography>
                  <Button variant="contained" onClick={openCreateDriveDialog}>Add Network Drive</Button>
                </Stack>
                <TableContainer sx={{ mb: 2 }}>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>Name</TableCell>
                        <TableCell>SMB Path</TableCell>
                        <TableCell>Mount Path</TableCell>
                        <TableCell>User</TableCell>
                        <TableCell>Status</TableCell>
                        <TableCell align="right">Actions</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {networkDrives.map((drive) => (
                        <TableRow key={drive.id} hover>
                          <TableCell>{drive.name}</TableCell>
                          <TableCell sx={{ maxWidth: 180, wordBreak: "break-all" }}>{drive.smb_path}</TableCell>
                          <TableCell sx={{ maxWidth: 180, wordBreak: "break-all" }}>{drive.mount_path ?? "-"}</TableCell>
                          <TableCell>{drive.username}</TableCell>
                          <TableCell>
                            <Stack spacing={0.5}>
                              <Chip
                                size="small"
                                label={drive.connection_status}
                                color={
                                  drive.connection_status === "connected"
                                    ? "success"
                                    : drive.connection_status === "partial"
                                      ? "warning"
                                      : drive.connection_status === "auth_failed" || drive.connection_status === "offline"
                                        ? "error"
                                        : "default"
                                }
                              />
                              {drive.last_error && (
                                <Typography variant="caption" color="text.secondary" sx={{ maxWidth: 220, wordBreak: "break-word" }}>
                                  {drive.last_error}
                                </Typography>
                              )}
                            </Stack>
                          </TableCell>
                          <TableCell align="right">
                            <Stack direction="row" spacing={1} justifyContent="flex-end">
                              <Button size="small" onClick={() => checkDrive(drive.id)}>Check</Button>
                              <Button size="small" onClick={() => openEditDriveDialog(drive)}>Edit</Button>
                              <Button size="small" color="error" onClick={() => removeDrive(drive.id)}>Delete</Button>
                            </Stack>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
                <Typography variant="h6" sx={{ mb: 1 }}>
                  Workflow Routing
                </Typography>
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
                        <TableCell>Filetypes</TableCell>
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
                          <TableCell sx={{ maxWidth: 120, wordBreak: "break-all" }}>{item.allowed_extensions ?? "all"}</TableCell>
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

              <Dialog open={networkDialogOpen} onClose={closeDriveDialog} fullWidth maxWidth="sm">
                <DialogTitle>{editingDriveId === null ? "Add Network Drive" : `Edit Network Drive #${editingDriveId}`}</DialogTitle>
                <DialogContent>
                  <Stack spacing={2} sx={{ mt: 1 }}>
                    <TextField
                      label="Name"
                      value={networkDriveForm.name}
                      onChange={(event) => setNetworkDriveForm((prev) => ({ ...prev, name: event.target.value }))}
                      fullWidth
                    />
                    <TextField
                      label="SMB Path"
                      placeholder="//server/share"
                      value={networkDriveForm.smb_path}
                      onChange={(event) => setNetworkDriveForm((prev) => ({ ...prev, smb_path: event.target.value }))}
                      fullWidth
                    />
                    <TextField
                      label="Local Mount Path (optional)"
                      placeholder="/srv/import/share3"
                      value={networkDriveForm.mount_path}
                      onChange={(event) => setNetworkDriveForm((prev) => ({ ...prev, mount_path: event.target.value }))}
                      helperText="Directory is auto-created if service user has permission."
                      fullWidth
                    />
                    <TextField
                      label="Username"
                      value={networkDriveForm.username}
                      onChange={(event) => setNetworkDriveForm((prev) => ({ ...prev, username: event.target.value }))}
                      fullWidth
                    />
                    <TextField
                      label={editingDriveId === null ? "Password" : "Password (leave empty to keep)"}
                      type="password"
                      value={networkDriveForm.password}
                      onChange={(event) => setNetworkDriveForm((prev) => ({ ...prev, password: event.target.value }))}
                      fullWidth
                    />
                    <FormControlLabel
                      control={
                        <Switch
                          checked={networkDriveForm.enabled}
                          onChange={(event) =>
                            setNetworkDriveForm((prev) => ({ ...prev, enabled: event.target.checked }))
                          }
                        />
                      }
                      label="Enabled"
                    />
                  </Stack>
                </DialogContent>
                <DialogActions>
                  <Button onClick={closeDriveDialog}>Cancel</Button>
                  {editingDriveId !== null && (
                    <Button
                      variant="outlined"
                      onClick={saveDriveAsNew}
                      disabled={
                        !networkDriveForm.name.trim() ||
                        !networkDriveForm.smb_path.trim() ||
                        !networkDriveForm.username.trim()
                      }
                    >
                      Save As
                    </Button>
                  )}
                  <Button
                    variant="contained"
                    onClick={submitDrive}
                    disabled={
                      !networkDriveForm.name.trim() ||
                      !networkDriveForm.smb_path.trim() ||
                      !networkDriveForm.username.trim() ||
                      (editingDriveId === null && !networkDriveForm.password)
                    }
                  >
                    {editingDriveId === null ? "Create" : "Save"}
                  </Button>
                </DialogActions>
              </Dialog>

              <Dialog
                open={driveOverwriteConfirmOpen}
                onClose={() => {
                  setDriveOverwriteConfirmOpen(false);
                  setDriveOverwriteTarget(null);
                }}
                fullWidth
                maxWidth="xs"
              >
                <DialogTitle>Overwrite Network Drive?</DialogTitle>
                <DialogContent>
                  <Stack spacing={1} sx={{ mt: 0.5 }}>
                    <Typography variant="body2" color="text.secondary">
                      Network drive name already exists: {driveOverwriteTarget?.name ?? ""}. Save will overwrite that network drive.
                    </Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ wordBreak: "break-all" }}>
                      Existing SMB: {driveOverwriteTarget?.smb_path ?? "-"}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ wordBreak: "break-all" }}>
                      Existing Mount: {driveOverwriteTarget?.mount_path ?? "-"}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ wordBreak: "break-all" }}>
                      New SMB: {networkDriveForm.smb_path || "-"}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ wordBreak: "break-all" }}>
                      New Mount: {networkDriveForm.mount_path || "-"}
                    </Typography>
                  </Stack>
                </DialogContent>
                <DialogActions>
                  <Button
                    onClick={() => {
                      setDriveOverwriteConfirmOpen(false);
                      setDriveOverwriteTarget(null);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button color="warning" variant="contained" onClick={confirmOverwriteDrive}>
                    Overwrite
                  </Button>
                </DialogActions>
              </Dialog>

              <Dialog
                open={overwriteConfirmOpen}
                onClose={() => {
                  setOverwriteConfirmOpen(false);
                  setOverwriteTarget(null);
                }}
                fullWidth
                maxWidth="xs"
              >
                <DialogTitle>Overwrite Workflow?</DialogTitle>
                <DialogContent>
                  <Typography variant="body2" color="text.secondary">
                    Workflow name already exists: {overwriteTarget?.name ?? ""}. Save will overwrite that workflow.
                  </Typography>
                </DialogContent>
                <DialogActions>
                  <Button
                    onClick={() => {
                      setOverwriteConfirmOpen(false);
                      setOverwriteTarget(null);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button color="warning" variant="contained" onClick={confirmOverwriteWorkflow}>
                    Overwrite
                  </Button>
                </DialogActions>
              </Dialog>
            </Stack>
          ) : (
            <Stack spacing={3}>
              <Paper sx={{ p: 2, border: "1px solid", borderColor: "divider" }}>
                <Typography variant="body2" color="text.secondary">
                  Next scheduled scan
                </Typography>
                <Typography variant="h6" sx={{ fontWeight: 700 }}>
                  {formatTimestamp(status?.next_scan_at ?? null)}
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                  Schedule state: {status?.scan_schedule_enabled ? "running" : "stopped"}
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                  Last scan: {formatTimestamp(status?.last_scan_at ?? null)} ({status?.last_scan_trigger ?? "-"})
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Last result: discovered {status?.last_scan_discovered ?? 0}, queued {status?.last_scan_queued ?? 0}
                </Typography>
                <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
                  <TextField
                    label="Scan Interval (seconds)"
                    size="small"
                    value={scanIntervalInput}
                    onChange={(event) => {
                      setScanIntervalInput(event.target.value);
                      setScanIntervalDirty(true);
                    }}
                  />
                  <Button variant="contained" onClick={applyScanInterval} disabled={refreshing}>
                    Apply
                  </Button>
                </Stack>
              </Paper>

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

              <Typography variant="body2" color="text.secondary">
                Workers = number of active background processor threads consuming queued files.
              </Typography>

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
      <Snackbar
        open={Boolean(error || notice)}
        autoHideDuration={6000}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
        onClose={() => {
          setError(null);
          setNotice(null);
        }}
      >
        <Alert
          severity={error ? "error" : "success"}
          variant="filled"
          onClose={() => {
            setError(null);
            setNotice(null);
          }}
          sx={{ width: "100%" }}
        >
          {error ?? notice ?? ""}
        </Alert>
      </Snackbar>
    </ThemeProvider>
  );
};
