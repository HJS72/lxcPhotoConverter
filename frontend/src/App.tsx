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
  IconButton,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Toolbar,
  Typography,
} from "@mui/material";
import DarkModeRoundedIcon from "@mui/icons-material/DarkModeRounded";
import LightModeRoundedIcon from "@mui/icons-material/LightModeRounded";
import AutorenewRoundedIcon from "@mui/icons-material/AutorenewRounded";
import { ThemeProvider } from "@mui/material/styles";

import { fetchHistory, fetchStatus, HistoryItem, StatusResponse, triggerScan } from "./api";
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
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [error, setError] = useState<string | null>(null);

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

  const refresh = async () => {
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

  const runScan = async () => {
    try {
      await triggerScan();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Scan failed");
    }
  };

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      void refresh();
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
                <Button
                  variant="contained"
                  startIcon={<AutorenewRoundedIcon />}
                  onClick={runScan}
                  disabled={refreshing}
                >
                  Scan Now
                </Button>
                <IconButton onClick={toggleMode} color="primary">
                  {mode === "dark" ? <LightModeRoundedIcon /> : <DarkModeRoundedIcon />}
                </IconButton>
              </Stack>
            </Toolbar>
          </AppBar>

          {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

          {loading ? (
            <Box sx={{ display: "grid", placeItems: "center", py: 10 }}>
              <CircularProgress />
            </Box>
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
