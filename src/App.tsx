import React, { useCallback, useState, useEffect, useRef } from "react";
import {
  MessageSquare,
  FileText,
  Users,
  Settings,
  Menu,
  Upload,
  Send,
  Trash2,
  Download,
  RefreshCw,
  UserCheck,
  UserX,
  LogOut,
  UserPlus,
  Search,
  Image as ImageIcon,
  Save,
  RotateCcw,
  Paperclip,
  Sparkles,
  BookOpen,
  FolderOpen,
  FileSearch,
  CheckCircle2,
  AlertTriangle,
  Clock,
  ListChecks,
  Table2,
  Eye,
  ChevronDown,
  Database,
  Layers,
  ClipboardList
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import * as XLSX from "xlsx";
import {
  Bar,
  BarChart,
  Cell,
  Legend,
  Line,
  LineChart,
  Area,
  AreaChart,
  Scatter,
  ScatterChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Dashboard as AnalyticsDashboard } from "./components/Dashboard";
import { ProposalBuilder } from "./components/ProposalBuilder";
import {
  emptyDashboardAnalytics,
  refreshDashboardAnalytics,
  type DashboardAnalytics,
} from "./utils/dashboardAnalytics";
import { apiFetch, apiHealthCheck, apiUrl, isDevTunnelHost, readJsonResponse } from "./utils/apiClient";

// ================= TYPES =================
type Message = {
  role: "user" | "assistant";
  content: string;
  question?: string;
  confidence?: number;
  answerStatus?: string;
  sources?: any[];
  suggestedQuestions?: string[];
  retrievalDebug?: any;
  fileRecommendations?: FileRecommendation[];
  feedbackSaved?: boolean;
};

type FileRecommendation = {
  documentId: string;
  uploadedFileId?: string;
  fileId?: string;
  filename: string;
  category?: string;
  module?: string;
  folder?: string;
  useFor?: string;
  reason?: string;
  confidence?: "High" | "Medium" | "Low" | string;
  score?: number;
  fileType?: string;
  downloadUrl?: string;
  previewUrl?: string;
  canDownload?: boolean;
};

type Profile = {
  id: string;
  email: string;
  full_name?: string;
  role: "admin" | "user" | string;
  status: "pending" | "approved" | "rejected";
  created_at: string;
};

type AppSettings = {
  app_logo_url: string;
  updated_by?: string;
  updated_at?: string;
};

const CHAT_STORAGE_KEY = "slp-active-chat-v1";
const PROFILE_STORAGE_KEY = "slp-local-profile-v1";
const CHAT_TTL_MS = 24 * 60 * 60 * 1000;
const APP_DATA_STALE_MS = 5 * 60 * 1000;

const welcomeMessage: Message = {
  role: "assistant",
  content: "What would you like to know?"
};

const DOCUMENT_FOLDERS = [
  "GUIDELINES",
  "SLPIS",
  "SLP DPT",
  "PROPOSALS",
  "TEMPLATES",
  "IMAGE",
  "OTHER DOCUMENTS",
];

function isAdminProfile(profile?: Profile | null) {
  return profile?.role === "admin" && profile.status === "approved";
}

function AdminRoute({ profile, children }: { profile: Profile | null; children: React.ReactNode }) {
  if (!isAdminProfile(profile)) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-red-800">
        <h2 className="text-lg font-bold">Access denied</h2>
        <p className="mt-1 text-sm">Admin Panel is available to admin accounts only.</p>
      </div>
    );
  }
  return <>{children}</>;
}

async function assertApiHealthy() {
  try {
    const data = await apiHealthCheck();
    if (!data?.ok) throw new Error("API health check failed.");
    if (data.database && data.database !== "connected") throw new Error("Database is not connected.");
    return data;
  } catch (error: any) {
    const tunnelHint = isDevTunnelHost()
      ? " Dev Tunnel detected. Make sure backend port 3001 is also forwarded and VITE_API_BASE_URL points to the 3001 tunnel URL."
      : "";
    throw new Error(`App loaded, but API/database is not connected. Please forward backend port 3001 or set VITE_API_BASE_URL.${tunnelHint} ${error.message || error}`);
  }
}

// ================= MAIN APP =================
export default function App() {
  const [tab, setTab] = useState<"dashboard" | "chat" | "docs" | "match" | "proposal" | "admin" | "tools">("dashboard");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [settings, setSettings] = useState<AppSettings>({ app_logo_url: "" });
  const [loadingProfile, setLoadingProfile] = useState(true);
  const [dashboardData, setDashboardData] = useState<DashboardAnalytics>(emptyDashboardAnalytics());
  const [dashboardStats, setDashboardStats] = useState<any>({});
  const [municipalityStats, setMunicipalityStats] = useState<any[]>([]);
  const [parsedRows, setParsedRows] = useState<any[]>([]);
  const [lastDashboardLoadedAt, setLastDashboardLoadedAt] = useState(0);
  const [isDashboardLoaded, setIsDashboardLoaded] = useState(false);
  const [isLoadingDashboard, setIsLoadingDashboard] = useState(false);
  const [dashboardError, setDashboardError] = useState("");
  const [filesData, setFilesData] = useState<any[]>([]);
  const [lastFilesLoadedAt, setLastFilesLoadedAt] = useState(0);
  const [isFilesLoaded, setIsFilesLoaded] = useState(false);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [filesError, setFilesError] = useState("");
  const isAdmin = isAdminProfile(profile);
  const loadDashboardData = useCallback(async (reason: string, options: { force?: boolean } = {}) => {
    const stale = Date.now() - lastDashboardLoadedAt > APP_DATA_STALE_MS;
    if (!options.force && isDashboardLoaded && !stale) return dashboardData;
    if (isLoadingDashboard) return dashboardData;

    console.log("Loading dashboard-data because:", reason);
    setIsLoadingDashboard(true);
    setDashboardError("");
    try {
      await assertApiHealthy();
      const next = await refreshDashboardAnalytics({ force: options.force });
      setDashboardData(next);
      setDashboardStats(next.summary);
      setMunicipalityStats(next.municipalities);
      setParsedRows(next.municipalityDrilldownRecords || []);
      setIsDashboardLoaded(true);
      setLastDashboardLoadedAt(Date.now());
      return next;
    } catch (error: any) {
      console.error("Dashboard data load failed", error);
      setDashboardError(error.message || "Dashboard data could not be loaded.");
      return dashboardData;
    } finally {
      setIsLoadingDashboard(false);
    }
  }, [dashboardData, isDashboardLoaded, isLoadingDashboard, lastDashboardLoadedAt]);

  const loadFilesData = useCallback(async (reason: string, options: { force?: boolean } = {}) => {
    const stale = Date.now() - lastFilesLoadedAt > APP_DATA_STALE_MS;
    if (!options.force && isFilesLoaded && !stale) return filesData;
    if (isLoadingFiles) return filesData;

    console.log("Loading files because:", reason);
    setIsLoadingFiles(true);
    setFilesError("");
    try {
      await assertApiHealthy();
      const res = await apiFetch("/api/documents", { cache: "no-store" }, { endpointName: "Documents" });
      const data = await readJsonResponse(res);
      const next = data.documents || [];
      setFilesData(next);
      setIsFilesLoaded(true);
      setLastFilesLoadedAt(Date.now());
      return next;
    } catch (error: any) {
      console.error("Files data load failed", error);
      setFilesError(error.message || "Documents could not be loaded.");
      return filesData;
    } finally {
      setIsLoadingFiles(false);
    }
  }, [filesData, isFilesLoaded, isLoadingFiles, lastFilesLoadedAt]);

  const invalidateAppData = useCallback((reason: string) => {
    console.log("Invalidating app data because:", reason);
    setLastDashboardLoadedAt(0);
    setLastFilesLoadedAt(0);
  }, []);

  const reloadAfterFileChange = useCallback(async (reason: string) => {
    invalidateAppData(reason);
    await Promise.all([
      loadFilesData(reason, { force: true }),
      loadDashboardData(reason, { force: true }),
    ]);
  }, [invalidateAppData, loadDashboardData, loadFilesData]);

  useEffect(() => {
    const loadProfile = async () => {
      try {
        const savedProfile = localStorage.getItem(PROFILE_STORAGE_KEY);
        if (savedProfile) {
          setProfile(JSON.parse(savedProfile));
          return;
        }

        const res = await apiFetch("/api/me", undefined, { endpointName: "Profile" });
        const data = await readJsonResponse(res);
        setProfile(data.profile || null);
      } catch (error) {
        console.error("Could not load profile", error);
      } finally {
        setLoadingProfile(false);
      }
    };

    if (localStorage.getItem("slp-logged-out") === "true") {
      setProfile(null);
      setLoadingProfile(false);
      return;
    }

    loadProfile();
  }, []);

  const loadSettings = async () => {
    try {
      const res = await apiFetch("/api/app-settings", undefined, { endpointName: "App settings" });
      const data = await readJsonResponse(res);
      setSettings(data.settings || { app_logo_url: "" });
    } catch (error) {
      console.error("Could not load app settings", error);
    }
  };

  useEffect(() => {
    loadSettings();
  }, []);

  useEffect(() => {
    if (tab === "admin" && !isAdmin) {
      setTab("dashboard");
    }
  }, [isAdmin, tab]);

  const logout = async () => {
    await apiFetch("/api/logout", { method: "POST" }, { endpointName: "Logout", retries: 0 }).catch(() => {});
    localStorage.setItem("slp-logged-out", "true");
    localStorage.removeItem(CHAT_STORAGE_KEY);
    localStorage.removeItem(PROFILE_STORAGE_KEY);
    setProfile(null);
    setTab("chat");
  };

  if (loadingProfile) {
    return (
      <div className="flex h-screen items-center justify-center bg-gradient-to-br from-[#ECFDF5] to-[#F0FDF4]">
        <div className="text-center">
          <div className="mb-4 flex justify-center">
            <div className="h-16 w-16 rounded-full border-4 border-[#D8E6E1] border-t-[#047857] animate-spin"></div>
          </div>
          <p className="text-lg font-medium text-[#064E3B]">Loading SLP Knowledge Assistant...</p>
        </div>
      </div>
    );
  }

  if (!profile) {
    return <LoginRegisterPage onLogin={setProfile} logoUrl={settings.app_logo_url} />;
  }

  return (
    <div className="flex h-screen bg-[#ECFDF5] text-[#0F172A]">
      {/* SIDEBAR */}
      {sidebarOpen && (
        <div className="flex w-72 flex-col bg-[#064E3B] text-white shadow-2xl border-r border-[#D8E6E1]">
          {/* Logo Section */}
          <div className="p-6 border-b border-white/10">
            <div className="flex items-center gap-3 mb-2">
              <AppLogo logoUrl={settings.app_logo_url} compact />
              <div>
                <h2 className="text-xl font-bold">SLP Assistant</h2>
                <p className="text-xs text-green-200">Knowledge Workspace</p>
              </div>
            </div>
          </div>

          {/* Navigation */}
          <div className="flex-1 overflow-auto py-4 px-3">
            {/* Main Section */}
            <div className="mb-6">
              <h3 className="text-xs font-bold text-green-300 px-3 mb-3 tracking-wide">MAIN</h3>
              <SidebarBtn 
                icon={<MessageSquare size={20} />}
                label="Dashboard"
                onClick={() => setTab("dashboard")}
                isActive={tab === "dashboard"}
              />
              <SidebarBtn 
                icon={<MessageSquare size={20} />}
                label="Chat Assistant"
                onClick={() => setTab("chat")}
                isActive={tab === "chat"}
              />
              <SidebarBtn 
                icon={<FileText size={20} />}
                label="Documents"
                onClick={() => setTab("docs")}
                isActive={tab === "docs"}
              />
            </div>

            {/* Data Tools Section */}
            <div className="mb-6">
              <h3 className="text-xs font-bold text-green-300 px-3 mb-3 tracking-wide">DATA TOOLS</h3>
              <SidebarBtn 
                icon={<Users size={20} />}
                label="Match & Compare"
                onClick={() => setTab("match")}
                isActive={tab === "match"}
              />
              <SidebarBtn
                icon={<ClipboardList size={20} />}
                label="Proposal Builder"
                onClick={() => setTab("proposal")}
                isActive={tab === "proposal"}
              />
            </div>

            {/* Admin Section */}
            {isAdmin && (
              <div>
                <h3 className="text-xs font-bold text-green-300 px-3 mb-3 tracking-wide">ADMIN</h3>
                <SidebarBtn 
                  icon={<Settings size={20} />}
                  label="Admin Panel"
                  onClick={() => setTab("admin")}
                  isActive={tab === "admin"}
                />
              </div>
            )}
          </div>

          {/* User Info & Footer */}
          <div className="p-4 border-t border-white/10">
            <div className="flex items-center justify-between gap-2 mb-3 pb-3 border-b border-white/10">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{profile.email}</p>
                <p className="text-xs text-green-200 capitalize">{profile.role}</p>
              </div>
              <div className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-[#10B981] text-xs font-bold text-white">
                {profile.role === "admin" && profile.status === "approved" ? "ADMIN" : "USER"}
              </div>
            </div>
            <p className="text-[10px] text-green-200 text-center">© 2026 mvltorio. All rights reserved.</p>
          </div>
        </div>
      )}

      {/* MAIN CONTENT */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* TOP BAR */}
        <div className="bg-white border-b border-[#D8E6E1] px-6 py-4 flex justify-between items-center shadow-sm">
          <div className="flex items-center gap-4">
            <button 
              onClick={() => setSidebarOpen(!sidebarOpen)} 
              className="rounded-lg p-2 text-[#0F172A] hover:bg-[#ECFDF5] transition-colors"
              title="Toggle sidebar"
            >
              <Menu size={24} />
            </button>
            <h1 className="text-2xl font-bold text-[#064E3B]">SLP Knowledge Assistant</h1>
          </div>
          <button
            onClick={logout}
            className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white bg-[#DC2626] hover:bg-red-700 transition-colors"
            title="Logout"
          >
            <LogOut size={18} />
            Logout
          </button>
        </div>

        {/* CONTENT AREA */}
        <div className="flex-1 overflow-auto">
          <div className="p-8 min-h-full">
            {tab === "dashboard" && (
              <AnalyticsDashboard
                profile={profile}
                onNavigate={(nextTab) => setTab(nextTab)}
                analytics={dashboardData}
                isLoaded={isDashboardLoaded}
                isLoading={isLoadingDashboard}
                error={dashboardError}
                lastLoadedAt={lastDashboardLoadedAt}
                loadAnalytics={loadDashboardData}
              />
            )}
            {tab === "chat" && <Chat profile={profile} />}
            {tab === "docs" && (
              <Documents
                profile={profile}
                docs={filesData}
                setDocs={setFilesData}
                isLoaded={isFilesLoaded}
                isLoading={isLoadingFiles}
                error={filesError}
                lastLoadedAt={lastFilesLoadedAt}
                loadDocs={loadFilesData}
                onFilesChanged={reloadAfterFileChange}
              />
            )}
            {tab === "match" && <NameMatching />}
            {tab === "proposal" && <ProposalBuilder />}
            {tab === "admin" && (
              <AdminRoute profile={profile}>
                <AdminPanel profile={profile} settings={settings} onSettingsChange={setSettings} />
              </AdminRoute>
            )}
          </div>
        </div>

        {/* FOOTER */}
        <div className="border-t border-[#D8E6E1] bg-white px-8 py-3 text-center text-[11px] text-[#64748B]">
          © 2026 mvltorio. All rights reserved.
        </div>
      </div>
    </div>
  );
}

function AppLogo({ logoUrl, compact = false }: { logoUrl?: string; compact?: boolean }) {
  const sizeClass = compact ? "h-10 w-10" : "h-16 w-16";

  if (logoUrl) {
    return (
      <img
        src={logoUrl}
        alt="App logo"
        className={`${sizeClass} rounded-xl border-2 border-[#D4AF37] bg-white object-contain shadow-md`}
      />
    );
  }

  return (
    <div className={`${sizeClass} flex items-center justify-center rounded-xl bg-[#10B981] text-white shadow-md ring-2 ring-[#D4AF37]`}>
      <MessageSquare size={compact ? 22 : 32} />
    </div>
  );
}

function LoginRegisterPage({
  onLogin,
  logoUrl,
}: {
  onLogin: (profile: Profile) => void;
  logoUrl?: string;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!email.trim() || !password.trim()) return;

    setSubmitting(true);
    setMessage("");

    try {
      const res = await apiFetch(mode === "login" ? "/api/login" : "/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, fullName }),
      });
      const data = await readJsonResponse(res);

      if (!res.ok) throw new Error(data.error || "Request failed.");

      if (mode === "login") {
        localStorage.removeItem("slp-logged-out");
        localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(data.profile));
        onLogin(data.profile);
      } else {
        setMessage(data.message || "Registration submitted for admin approval.");
        setMode("login");
        setPassword("");
      }
    } catch (error: any) {
      setMessage(error.message === "Failed to fetch"
        ? "Cannot reach the local API. Make sure the API server is running on port 3000."
        : error.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#ECFDF5] via-white to-[#F0FDF4] flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        {/* Card */}
        <div className="rounded-2xl border border-[#D8E6E1] bg-white p-8 shadow-2xl">
          {/* Logo and Heading */}
          <div className="text-center mb-8">
            <div className="flex justify-center mb-4">
              <AppLogo logoUrl={logoUrl} />
            </div>
            <h1 className="text-3xl font-bold text-[#064E3B] mb-2">SLP Knowledge Assistant</h1>
            <p className="text-sm text-[#64748B]">Secure access to data and tools</p>
          </div>

          {/* Mode Toggle */}
          <div className="mb-6 grid grid-cols-2 gap-2 rounded-lg bg-[#F0FDF4] p-1">
            <button
              onClick={() => setMode("login")}
              className={`rounded-lg px-4 py-2 text-sm font-semibold transition-all ${
                mode === "login"
                  ? "bg-white text-[#064E3B] shadow-md"
                  : "text-[#64748B]"
              }`}
            >
              Login
            </button>
            <button
              onClick={() => setMode("register")}
              className={`rounded-lg px-4 py-2 text-sm font-semibold transition-all ${
                mode === "register"
                  ? "bg-white text-[#064E3B] shadow-md"
                  : "text-[#64748B]"
              }`}
            >
              Register
            </button>
          </div>

          {/* Form */}
          {mode === "register" && (
            <input
              className="mb-4 w-full rounded-lg border border-[#D8E6E1] px-4 py-3 text-sm focus:border-[#10B981] focus:outline-none focus:ring-2 focus:ring-[#10B981]/20"
              placeholder="Full name"
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
            />
          )}
          <input
            className="mb-4 w-full rounded-lg border border-[#D8E6E1] px-4 py-3 text-sm focus:border-[#10B981] focus:outline-none focus:ring-2 focus:ring-[#10B981]/20"
            placeholder="Email address"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <input
            className="mb-6 w-full rounded-lg border border-[#D8E6E1] px-4 py-3 text-sm focus:border-[#10B981] focus:outline-none focus:ring-2 focus:ring-[#10B981]/20"
            placeholder="Password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
            }}
          />

          {/* Submit Button */}
          <button
            onClick={submit}
            disabled={submitting || !email.trim() || !password.trim()}
            className="mb-4 w-full rounded-lg bg-[#047857] px-4 py-3 font-semibold text-white hover:bg-[#065F46] disabled:opacity-50 transition-colors"
          >
            {submitting ? "Please wait..." : mode === "login" ? "Sign In" : "Create Account"}
          </button>

          {/* Message */}
          {message && (
            <div className={`rounded-lg p-4 text-sm mb-4 ${
              message.includes("fail") || message.includes("error")
                ? "bg-red-50 text-red-800 border border-red-200"
                : "bg-green-50 text-green-800 border border-green-200"
            }`}>
              {message}
            </div>
          )}

          {/* Footer */}
          <div className="border-t border-[#D8E6E1] pt-4 text-center text-[11px] text-[#64748B]">
            © 2026 mvltorio. All rights reserved.
          </div>
        </div>
      </div>
    </div>
  );
}

// ================= SIDEBAR BUTTON =================
interface SidebarBtnProps {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  isActive?: boolean;
}

function SidebarBtn({ icon, label, onClick, isActive = false }: SidebarBtnProps) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-3 w-full p-3 rounded-lg text-sm font-medium transition-all mb-2 ${
        isActive
          ? "bg-[#10B981] text-white shadow-lg"
          : "text-green-100 hover:bg-[#065F46]"
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

// ================= DASHBOARD =================
function Dashboard({ profile }: { profile: Profile | null }) {
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadDashboard = async () => {
      try {
      const res = await apiFetch("/api/admin/stats?adminId=" + (profile?.id || ""), undefined, { endpointName: "Admin stats" });
        const data = await readJsonResponse(res);
        setStats(data.stats || {});
      } catch (error) {
        console.error("Could not load dashboard stats", error);
      } finally {
        setLoading(false);
      }
    };

    loadDashboard();
  }, [profile?.id]);

  return (
    <div>
      <div className="mb-8">
        <h2 className="text-3xl font-bold text-[#064E3B] mb-2">Welcome, {profile?.full_name || profile?.email}</h2>
        <p className="text-[#64748B]">Your SLP Knowledge Assistant dashboard</p>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <DashboardCard
          title="Total Documents"
          value={stats?.totalDocuments || 0}
          icon={<FileText className="text-[#10B981]" size={28} />}
          color="emerald"
        />
        <DashboardCard
          title="Questions Asked"
          value={stats?.questionsAsked || 0}
          icon={<MessageSquare className="text-[#2563EB]" size={28} />}
          color="blue"
        />
        <DashboardCard
          title="Reports Generated"
          value={stats?.reportsGenerated || 0}
          icon={<Download className="text-[#F59E0B]" size={28} />}
          color="amber"
        />
        <DashboardCard
          title="Active Users"
          value={stats?.approvedUsers || 0}
          icon={<Users className="text-[#047857]" size={28} />}
          color="green"
        />
      </div>

      <div className="mb-8">
        <div className="max-w-2xl">
          <h3 className="text-xl font-bold text-[#064E3B] mb-4">Quick Actions</h3>
          <div className="space-y-2">
            <button className="w-full text-left px-4 py-3 rounded-lg bg-white border border-[#D8E6E1] hover:bg-[#F0FDF4] transition-colors">
              <p className="font-medium text-[#064E3B]">Start a New Chat</p>
              <p className="text-sm text-[#64748B]">Ask the assistant a question</p>
            </button>
            <button className="w-full text-left px-4 py-3 rounded-lg bg-white border border-[#D8E6E1] hover:bg-[#F0FDF4] transition-colors">
              <p className="font-medium text-[#064E3B]">Upload Documents</p>
              <p className="text-sm text-[#64748B]">Add new files to the knowledge base</p>
            </button>
            <button className="w-full text-left px-4 py-3 rounded-lg bg-white border border-[#D8E6E1] hover:bg-[#F0FDF4] transition-colors">
              <p className="font-medium text-[#064E3B]">Match Names</p>
              <p className="text-sm text-[#64748B]">Find duplicate entries</p>
            </button>
          </div>
        </div>
      </div>

      {/* Empty state for recent activity */}
      <div className="bg-white border border-[#D8E6E1] rounded-xl p-6">
        <h3 className="text-lg font-bold text-[#064E3B] mb-4">Recent Activity</h3>
        <div className="text-center py-8">
          <p className="text-[#64748B]">No activity yet. Start by uploading documents or asking a question.</p>
        </div>
      </div>
    </div>
  );
}

function DashboardCard({ title, value, icon, color }: any) {
  const bgColors: Record<string, string> = {
    emerald: "bg-[#F0FDF4]",
    blue: "bg-blue-50",
    amber: "bg-amber-50",
    green: "bg-green-50",
  };

  return (
    <div className={`${bgColors[color]} rounded-xl border border-[#D8E6E1] p-6`}>
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-medium text-[#64748B] mb-1">{title}</p>
          <p className="text-3xl font-bold text-[#064E3B]">{value}</p>
        </div>
        <div className="p-2 bg-white rounded-lg">{icon}</div>
      </div>
    </div>
  );
}

// ================= CHAT =================
function loadSavedChat() {
  try {
    const saved = JSON.parse(localStorage.getItem(CHAT_STORAGE_KEY) || "null");

    if (!saved?.createdAt || Date.now() - saved.createdAt > CHAT_TTL_MS) {
      localStorage.removeItem(CHAT_STORAGE_KEY);
      return { createdAt: Date.now(), messages: [welcomeMessage] };
    }

    return {
      createdAt: saved.createdAt,
      messages: Array.isArray(saved.messages) && saved.messages.length ? saved.messages : [welcomeMessage]
    };
  } catch {
    return { createdAt: Date.now(), messages: [welcomeMessage] };
  }
}

function Chat({ profile }: { profile: Profile | null }) {
  const savedChat = loadSavedChat();
  const [chatStartedAt, setChatStartedAt] = useState(savedChat.createdAt);
  const [messages, setMessages] = useState<Message[]>(savedChat.messages);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<FileList | null>(null);
  const [uploadStatus, setUploadStatus] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const userMessages = messages.filter((message) => message.role === "user");
  const assistantMessages = messages.filter((message) => message.role === "assistant");
  const latestAssistant = assistantMessages[assistantMessages.length - 1];
  const latestSources = latestAssistant ? extractSourceCards(latestAssistant.content, latestAssistant.sources) : [];
  const allSources = assistantMessages.flatMap((message) => extractSourceCards(message.content, message.sources));
  const uniqueSources = uniqueByLabel(allSources).slice(0, 6);
  const hasRealQuestion = userMessages.length > 0;
  const status = uploadStatus || attachments?.length
    ? "Using uploaded sources"
    : latestAssistant?.content && /api is offline|failed to fetch|health check|timed out|offline/i.test(latestAssistant.content)
      ? "API Offline"
      : "RAG Ready";
  const statusTone = status === "API Offline" ? "bg-red-50 text-red-700 border-red-100" : status === "Using uploaded sources" ? "bg-amber-50 text-amber-700 border-amber-100" : "bg-emerald-50 text-emerald-700 border-emerald-100";
  const quickPrompts = [
    { icon: ListChecks, label: "What are the 5 implementation phases of SLP?" },
    { icon: FolderOpen, label: "List available templates" },
    { icon: FileSearch, label: "Analyze my uploaded monitoring file" },
    { icon: AlertTriangle, label: "Show projects without GUR" },
    { icon: BookOpen, label: "Summarize this guideline" },
  ];
  const quickActions = [
    "List guidelines",
    "List templates",
    "Analyze uploaded file",
    "Create summary",
    "Generate table",
    "Download source document",
  ];

  useEffect(() => {
    localStorage.setItem(
      CHAT_STORAGE_KEY,
      JSON.stringify({ createdAt: chatStartedAt, messages })
    );
  }, [chatStartedAt, messages]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const startNewChat = () => {
    const next = { createdAt: Date.now(), messages: [welcomeMessage] };
    setChatStartedAt(next.createdAt);
    setMessages(next.messages);
    setInput("");
    setAttachments(null);
    setUploadStatus("");
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(next));
  };

  const send = async () => {
    if ((!input.trim() && !attachments?.length) || sending) return;
    const uploadedNames: string[] = [];

    const newMessages: Message[] = [
      ...messages,
      { role: "user", content: `${input || "Analyze attached file(s)."}${attachments?.length ? `\n\nAttached: ${Array.from(attachments).map((file) => file.name).join(", ")}` : ""}` }
    ];
    setMessages(newMessages);
    setSending(true);

    try {
      if (attachments?.length) {
        setUploadStatus("Uploading and indexing attached file(s)...");
        for (let index = 0; index < attachments.length; index++) {
          const file = attachments[index];
          const dataUrl = await readFileAsDataUrl(file);
          const res = await apiFetch("/api/upload-document", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              fileName: file.name,
              fileType: file.type || "application/octet-stream",
              fileSize: file.size,
              folder: "OTHER DOCUMENTS",
              data: dataUrl.split(",")[1],
              userId: profile?.id,
              chatAttachment: true,
              chatSessionId: String(chatStartedAt),
            }),
          });
          const uploadData = await readJsonResponse(res);
          if (!res.ok) throw new Error(uploadData.error || `Upload failed for ${file.name}`);
          uploadedNames.push(file.name);
          if (uploadData.document?.id) {
            uploadedNames.push(`id:${uploadData.document.id}`);
          }
        }
        setUploadStatus("Attached file(s) indexed. Asking assistant...");
      }

      const uploadedFileNames = uploadedNames.filter((item) => !item.startsWith("id:"));
      const attachmentIds = uploadedNames.filter((item) => item.startsWith("id:")).map((item) => item.slice(3));
      const finalMessage = [
        input || "Analyze the attached uploaded file(s).",
        uploadedFileNames.length ? `Use the newly uploaded attached file(s): ${uploadedFileNames.join(", ")}.` : "",
      ].filter(Boolean).join("\n");

      const res = await apiFetch("/api/chat-rag", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: finalMessage,
          history: messages,
          userId: profile?.id,
          attachmentIds,
          chatSessionId: String(chatStartedAt),
        })
      });

      const data = await readJsonResponse(res);

      setMessages([
        ...newMessages,
        {
          role: "assistant",
          content: data.answer || data.error || "No response",
          question: input || "Analyze the attached uploaded file(s).",
          confidence: data.confidence,
          answerStatus: data.answerStatus,
          sources: data.sources || [],
          suggestedQuestions: data.suggestedQuestions || [],
          retrievalDebug: data.retrievalDebug,
          fileRecommendations: data.fileRecommendations || [],
        }
      ]);
    } catch (error: any) {
      setMessages([
        ...newMessages,
        { role: "assistant", content: error.message }
      ]);
    } finally {
      setSending(false);
    }

    setInput("");
    setAttachments(null);
    setUploadStatus("");
  };

  return (
    <div className="grid min-h-[calc(100vh-150px)] gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="flex min-h-[680px] flex-col overflow-hidden rounded-xl border border-[#D8E6E1] bg-white shadow-sm">
        <div className="border-b border-[#D8E6E1] bg-[#F8FCFA] p-4 sm:p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-start gap-3">
              <div className="rounded-xl bg-[#064E3B] p-3 text-white shadow-sm">
                <MessageSquare size={22} />
              </div>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-2xl font-bold text-[#064E3B]">Chat Assistant</h2>
                  <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-bold ${statusTone}`}>
                    {status === "API Offline" ? <AlertTriangle size={13} /> : <CheckCircle2 size={13} />}
                    {status}
                  </span>
                </div>
                <p className="mt-1 max-w-2xl text-sm text-[#64748B]">
                  Ask about SLP guidelines, dashboard data, monitoring files, templates, and uploaded source documents. Chats persist for 24 hours.
                </p>
              </div>
            </div>
            <button
              onClick={startNewChat}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#047857] px-4 py-2 text-sm font-semibold text-white hover:bg-[#065F46]"
            >
              <RefreshCw size={18} />
              New Chat
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto bg-[#F8FAFC] p-3 sm:p-5">
          {!hasRealQuestion ? (
            <div className="mx-auto flex min-h-[440px] max-w-4xl flex-col justify-center">
              <div className="mb-5 text-center">
                <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-[#F0FDF4] text-[#047857] shadow-sm ring-1 ring-[#D8E6E1]">
                  <Sparkles size={26} />
                </div>
                <h3 className="text-2xl font-bold text-[#064E3B]">What would you like to know about SLP?</h3>
                <p className="mt-2 text-sm text-[#64748B]">Start with a focused question or attach a file for analysis.</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {quickPrompts.map((prompt) => {
                  const Icon = prompt.icon;
                  return (
                    <button
                      key={prompt.label}
                      type="button"
                      onClick={() => setInput(prompt.label)}
                      className="rounded-xl border border-[#D8E6E1] bg-white p-4 text-left shadow-sm hover:border-[#10B981] hover:bg-[#F0FDF4]"
                    >
                      <Icon size={20} className="mb-3 text-[#047857]" />
                      <span className="text-sm font-semibold text-[#064E3B]">{prompt.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {messages.filter((message) => !(message.role === "assistant" && message.content === welcomeMessage.content)).map((m, i) => (
                <ChatMessage
                  key={i}
                  message={m}
                  onPromptClick={setInput}
                  profile={profile}
                />
              ))}
            </div>
          )}
        {sending && (
          <div className="flex justify-start">
            <div className="w-full max-w-[720px] rounded-xl rounded-tl-md border border-[#D8E6E1] bg-white p-4 shadow-sm">
              <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-[#064E3B]">
                <RefreshCw size={16} className="animate-spin" />
                Preparing answer and checking evidence...
              </div>
              <div className="space-y-2">
                <div className="slp-skeleton-line w-11/12" />
                <div className="slp-skeleton-line w-9/12" />
                <div className="slp-skeleton-line w-2/3" />
              </div>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="sticky bottom-0 border-t border-[#D8E6E1] bg-white p-3 sm:p-4">
        {uploadStatus && (
          <div className="mb-3 rounded-lg border border-blue-100 bg-blue-50 px-4 py-2 text-sm text-blue-700">
            {uploadStatus}
          </div>
        )}
        {attachments?.length ? (
          <div className="mb-3 flex flex-wrap gap-2">
            {Array.from(attachments).map((file) => (
              <span key={`${file.name}-${file.size}`} className="inline-flex items-center gap-2 rounded-full border border-[#D8E6E1] bg-[#F0FDF4] px-3 py-1 text-xs font-semibold text-[#064E3B]">
                <Paperclip size={13} /> {file.name}
              </span>
            ))}
          </div>
        ) : null}
        <div className="flex flex-col gap-2 rounded-xl border border-[#D8E6E1] bg-[#F8FAFC] p-2 shadow-inner sm:flex-row sm:items-end">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".csv,.xlsx,.xls,.pdf,.png,.jpg,.jpeg,.webp,text/csv,application/pdf,image/png,image/jpeg,image/webp"
            onChange={(event) => setAttachments(event.target.files)}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-[#D8E6E1] bg-white text-[#047857] hover:bg-[#F0FDF4]"
            title="Attach file"
          >
            <Paperclip size={19} />
          </button>
          <input
            className="min-h-11 flex-1 bg-transparent px-2 text-sm outline-none"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about SLP guidelines, participants, projects, monitoring, GUR, training, or uploaded files..."
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && send()}
          />
          <button 
            onClick={send} 
            disabled={sending || (!input.trim() && !attachments?.length)}
            className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-[#047857] px-4 text-sm font-semibold text-white hover:bg-[#065F46] disabled:opacity-50 sm:w-auto"
          >
            {sending ? <RefreshCw size={20} className="animate-spin" /> : <Send size={20} />}
            Send
          </button>
        </div>
        <p className="mt-2 text-xs text-[#64748B]">Answers are based on uploaded documents and dashboard data when available.</p>
      </div>
    </div>

      <aside className="space-y-3 xl:sticky xl:top-0 xl:max-h-[calc(100vh-150px)] xl:overflow-auto">
        <ContextPanelCard title="Active Sources" icon={<FolderOpen size={18} />}>
          {uniqueSources.length ? (
            <div className="space-y-2">
              {uniqueSources.map((source) => (
                <SourceBadgeCard key={`${source.label}-${source.href || ""}`} source={source} compact />
              ))}
            </div>
          ) : (
            <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">No supporting source found in uploaded documents.</p>
          )}
        </ContextPanelCard>

        <ContextPanelCard title="Recent Questions" icon={<Clock size={18} />}>
          <div className="space-y-2">
            {userMessages.slice(-5).reverse().map((message, index) => (
              <button key={`${message.content}-${index}`} type="button" onClick={() => setInput(message.content.split("\n")[0])} className="block w-full rounded-lg border border-[#D8E6E1] bg-white p-3 text-left text-sm text-[#334155] hover:bg-[#F0FDF4]">
                {message.content.split("\n")[0]}
              </button>
            ))}
            {!userMessages.length && <p className="text-sm text-[#64748B]">Recent questions will appear here.</p>}
          </div>
        </ContextPanelCard>

        <ContextPanelCard title="Quick Actions" icon={<Sparkles size={18} />}>
          <div className="grid gap-2">
            {quickActions.map((action) => (
              <button key={action} type="button" onClick={() => setInput(action)} className="rounded-lg border border-[#D8E6E1] bg-white px-3 py-2 text-left text-sm font-semibold text-[#064E3B] hover:bg-[#F0FDF4]">
                {action}
              </button>
            ))}
          </div>
        </ContextPanelCard>

        <ContextPanelCard title="Upload Context" icon={<Upload size={18} />}>
          <div className="rounded-lg bg-[#F0FDF4] p-3 text-sm text-[#064E3B]">
            <p className="font-semibold">{attachments?.length || 0} file(s) selected</p>
            <p className="mt-1 text-xs text-[#64748B]">Attached files are indexed before the question is sent.</p>
          </div>
        </ContextPanelCard>

        <ContextPanelCard title="Retrieval Status" icon={<Database size={18} />}>
          <div className="grid grid-cols-2 gap-2">
            <MiniStatus label="Sources searched" value={uniqueSources.length || (hasRealQuestion ? "Active" : "Idle")} />
            <MiniStatus label="Sources used" value={latestSources.length} />
            <MiniStatus label="Matching chunks" value={estimateMatchingChunks(latestAssistant?.content || "")} />
            <MiniStatus label="Evidence status" value={latestSources.length ? "Supported" : "Pending"} />
          </div>
        </ContextPanelCard>
      </aside>
    </div>
  );
}

type SourceCard = {
  label: string;
  href?: string;
  documentId?: string;
  uploadedFileId?: string;
  fileId?: string;
  originalFilename?: string;
  storedFilename?: string;
  filePath?: string;
  storageKey?: string;
  folder?: string;
  category?: string;
  module?: string;
  fileType?: string;
  mimeType?: string;
  sourceFile?: string;
  previewUrl?: string;
  canDownload?: boolean;
  section?: string;
  evidenceType?: string;
  detail?: string;
};

function ChatMessage({ message, onPromptClick, profile }: { message: Message; onPromptClick: (prompt: string) => void; profile: Profile | null }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[92%] rounded-xl rounded-tr-md bg-[#047857] px-4 py-3 text-sm leading-6 text-white shadow-sm sm:max-w-[78%]">
          <p className="whitespace-pre-wrap">{message.content}</p>
        </div>
      </div>
    );
  }

  const directAnswer = getDirectAnswer(message.content);
  const sources = extractSourceCards(message.content, message.sources);
  const suggestedQuestions = message.suggestedQuestions?.length ? message.suggestedQuestions : extractSuggestedQuestions(message.content);
  const downloadLinks = sources.filter((source) => source.href);
  const fileRecommendations = message.fileRecommendations || [];
  const isTemplateRecommendation = Boolean(fileRecommendations.length || message.retrievalDebug?.templateRecommendation);
  const isAdmin = profile?.role === "admin" && profile.status === "approved";
  const confidence = typeof message.confidence === "number" ? message.confidence : undefined;
  const confidenceLabel = message.answerStatus === "refused_no_evidence"
    ? "Cannot answer from uploaded data"
    : confidence === undefined
    ? ""
    : confidence >= 0.7
    ? "High confidence"
    : confidence >= 0.45
    ? "Medium confidence"
    : "Low confidence";

  return (
    <div className="flex justify-start">
      <div className="w-full max-w-[900px] rounded-xl rounded-tl-md border border-[#D8E6E1] bg-white p-4 text-[#0F172A] shadow-sm sm:p-5">
        <div className="mb-3 flex flex-wrap items-center gap-2 text-[#064E3B]">
          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#ECFDF5] text-[#047857]">
            <Sparkles size={17} />
          </span>
          <h3 className="mr-auto font-bold">Direct Answer</h3>
          {confidence !== undefined && (
            <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${confidence >= 0.7 ? "bg-emerald-50 text-emerald-700" : confidence >= 0.45 ? "bg-amber-50 text-amber-700" : "bg-red-50 text-red-700"}`}>
              {confidenceLabel} · {Math.round(confidence * 100)}%
            </span>
          )}
          <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${(isTemplateRecommendation ? fileRecommendations.length : sources.length) ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
            {isTemplateRecommendation ? "Template mode" : sources.length ? "Source evidence" : "No source evidence"}
          </span>
        </div>
        <div className="prose max-w-none text-sm prose-headings:text-[#064E3B] prose-a:text-[#047857]">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents("assistant")}>
            {directAnswer}
          </ReactMarkdown>
        </div>

        <ChartsFromMessage content={message.content} />

        <div className="mt-4 rounded-xl border border-[#D8E6E1] bg-[#F8FAFC]">
          <details className="group" open={(isTemplateRecommendation ? fileRecommendations.length : sources.length) > 0}>
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3">
              <span className="inline-flex items-center gap-2 font-bold text-[#064E3B]">
                <Layers size={17} /> {isTemplateRecommendation ? "Recommended File(s)" : "Evidence Used"}
              </span>
              <ChevronDown size={17} className="text-[#64748B] transition-transform group-open:rotate-180" />
            </summary>
            <div className="border-t border-[#D8E6E1] p-3 sm:p-4">
              {isTemplateRecommendation && fileRecommendations.length ? (
                <div className="grid gap-3">
                  {fileRecommendations.slice(0, 3).map((file) => (
                    <RecommendedFileCard key={file.documentId || file.filename} file={file} />
                  ))}
                </div>
              ) : sources.length ? (
                <div className="grid gap-3 lg:grid-cols-2">
                  {sources.map((source, index) => (
                    <SourceBadgeCard key={`${source.label}-${index}`} source={source} />
                  ))}
                </div>
              ) : (
                <div className="slp-empty-state text-amber-800">
                  No supporting source found in uploaded documents.
                </div>
              )}
            </div>
          </details>
        </div>

        {!isTemplateRecommendation && <div className="mt-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-bold text-[#064E3B]">
            <FolderOpen size={16} /> Source Files
          </div>
          {sources.length ? (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {sources.map((source, index) => (
                <span key={`${source.label}-badge-${index}`} className="rounded-lg border border-[#D8E6E1] bg-[#F0FDF4] px-3 py-2 text-xs font-semibold text-[#064E3B]">
                  {source.folder ? `[${source.folder}] ` : ""}{source.label}
                </span>
              ))}
            </div>
          ) : (
            <p className="slp-empty-state text-amber-800">No supporting source found in uploaded documents.</p>
          )}
        </div>}

        {!isTemplateRecommendation && <div className="mt-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-bold text-[#064E3B]">
            <MessageSquare size={16} /> Suggested Next Questions
          </div>
          <div className="flex flex-wrap gap-2">
            {suggestedQuestions.map((question) => (
              <button key={question} type="button" onClick={() => onPromptClick(question)} className="rounded-full border border-[#D8E6E1] bg-white px-3 py-1.5 text-xs font-semibold text-[#047857] hover:bg-[#F0FDF4]">
                {question}
              </button>
            ))}
          </div>
        </div>}

        {!isTemplateRecommendation && <div className="mt-4 grid gap-2 sm:flex sm:flex-wrap">
          {downloadLinks.slice(0, 3).map((source, index) => (
            <a key={`${source.href}-${index}`} href={source.href} className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#064E3B] px-3 py-2 text-xs font-semibold text-white hover:bg-[#047857]">
              <Download size={14} /> Download File
            </a>
          ))}
          {sources[0]?.href && (
            <a href={sources[0].href} className="inline-flex items-center justify-center gap-2 rounded-lg border border-[#D8E6E1] bg-white px-3 py-2 text-xs font-semibold text-[#047857] hover:bg-[#F0FDF4]">
              <Eye size={14} /> View Source
            </a>
          )}
          <button type="button" onClick={() => onPromptClick("Explain this with more detail and cite the source section used.")} className="inline-flex items-center justify-center gap-2 rounded-lg border border-[#D8E6E1] bg-white px-3 py-2 text-xs font-semibold text-[#047857] hover:bg-[#F0FDF4]">
            <MessageSquare size={14} /> Ask follow-up
          </button>
          {hasMarkdownTables(message.content) && (
            <>
              <button type="button" onClick={() => exportMarkdownTables(message.content, "xlsx")} className="inline-flex items-center justify-center gap-2 rounded-lg border border-[#D8E6E1] bg-white px-3 py-2 text-xs font-semibold text-[#047857] hover:bg-[#F0FDF4]">
                <Download size={14} /> XLSX
              </button>
              <button type="button" onClick={() => exportMarkdownTables(message.content, "csv")} className="inline-flex items-center justify-center gap-2 rounded-lg border border-[#D8E6E1] bg-white px-3 py-2 text-xs font-semibold text-[#047857] hover:bg-[#F0FDF4]">
                <Download size={14} /> CSV
              </button>
            </>
          )}
        </div>}
        <AnswerFeedbackControls message={message} isAdmin={isAdmin} onPromptClick={onPromptClick} />
      </div>
    </div>
  );
}

function RecommendedFileCard({ file }: { file: FileRecommendation }) {
  const downloadHref = file.downloadUrl ? apiUrl(file.downloadUrl) : "";
  const previewHref = file.previewUrl ? apiUrl(file.previewUrl) : "";
  const confidenceTone = file.confidence === "High"
    ? "bg-emerald-50 text-emerald-700"
    : file.confidence === "Medium"
    ? "bg-amber-50 text-amber-700"
    : "bg-red-50 text-red-700";
  const evidence = file;

  console.log("VISIBLE_EVIDENCE_CARD_PAYLOAD", evidence);
  console.log("VISIBLE_EVIDENCE_CARD_DOWNLOAD_STATE", {
    title: evidence.filename,
    fileName: evidence.filename,
    canDownload: evidence.canDownload,
    downloadUrl: evidence.downloadUrl,
    documentId: evidence.documentId,
    uploadedFileId: evidence.uploadedFileId
  });

  return (
    <div className="rounded-lg border border-[#D8E6E1] bg-white p-3 shadow-sm sm:p-4">
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <FileText size={18} className="text-[#047857]" />
            <p className="break-words text-sm font-bold text-[#064E3B]">{file.filename}</p>
            {file.confidence && <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${confidenceTone}`}>{file.confidence}</span>}
          </div>
          <div className="mt-3 grid gap-2 text-xs text-[#475569] sm:grid-cols-2">
            <p>Category/Module: <span className="font-semibold text-[#334155]">{[file.category, file.module].filter(Boolean).join(" / ") || "Uploaded file"}</span></p>
            <p>File type: <span className="font-semibold text-[#334155]">{file.fileType || "FILE"}</span></p>
            {file.useFor && <p>Use for: <span className="font-semibold text-[#334155]">{file.useFor}</span></p>}
            {file.reason && <p className="sm:col-span-2">{file.reason}</p>}
            {file.confidence === "Low" && <p className="font-semibold text-red-700 sm:col-span-2">Please verify this file before use.</p>}
          </div>
        </div>
        <div className="grid shrink-0 gap-2 sm:flex sm:flex-wrap lg:min-w-36 lg:justify-end">
          {downloadHref ? (
            <a href={downloadHref} className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#064E3B] px-3 py-2 text-xs font-semibold text-white hover:bg-[#047857]">
              <Download size={14} /> Download
            </a>
          ) : (
            <span className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700">Download unavailable - file could not be resolved.</span>
          )}
          {previewHref && (
            <a href={previewHref} target="_blank" rel="noreferrer" className="inline-flex items-center justify-center gap-2 rounded-lg border border-[#D8E6E1] bg-white px-3 py-2 text-xs font-semibold text-[#047857] hover:bg-[#F0FDF4]">
              <Eye size={14} /> Preview
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function AnswerFeedbackControls({ message, isAdmin, onPromptClick }: { message: Message; isAdmin: boolean; onPromptClick: (prompt: string) => void }) {
  const [teaching, setTeaching] = useState(false);
  const [correctAnswer, setCorrectAnswer] = useState("");
  const [correctSourceFile, setCorrectSourceFile] = useState("");
  const [correctFolder, setCorrectFolder] = useState("");
  const [correctModule, setCorrectModule] = useState("");
  const [notes, setNotes] = useState("");
  const [status, setStatus] = useState("");
  const question = message.question || "";

  async function saveFeedback(feedbackType: string, extra: Record<string, any> = {}) {
    setStatus("");
    const res = await apiFetch("/api/feedback/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, answer: message.content, feedbackType, rating: feedbackType, ...extra }),
    });
    const data = await readJsonResponse(res);
    setStatus(data.success ? "Feedback saved." : "Feedback could not be saved.");
  }

  async function saveCorrection() {
    if (!correctAnswer.trim()) return;
    setStatus("");
    const res = await apiFetch("/api/feedback/teach", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        originalQuestion: question,
        correctAnswer,
        correctSourceFile,
        correctFolder,
        correctModule,
        notes,
        createdBy: "",
      }),
    });
    const data = await readJsonResponse(res);
    await saveFeedback("wrong", {
      correctionId: data.correctionId,
      notes,
      sourceCorrection: JSON.stringify({ correctSourceFile, correctFolder, correctModule }),
    });
    setStatus("Correction saved. Future similar questions will use this taught answer.");
    setTeaching(false);
  }

  return (
    <div className="mt-4 border-t border-[#D8E6E1] pt-3">
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => saveFeedback("confirmed")} className="rounded-lg border border-[#D8E6E1] bg-white px-3 py-1.5 text-xs font-semibold text-[#047857] hover:bg-[#F0FDF4]">
          Confirm answer
        </button>
        <button type="button" onClick={() => setTeaching((current) => !current)} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-700 hover:bg-amber-100">
          Wrong answer? Teach me
        </button>
        <button type="button" onClick={() => saveFeedback("needs_review")} className="rounded-lg border border-[#D8E6E1] bg-white px-3 py-1.5 text-xs font-semibold text-[#64748B] hover:bg-[#F8FAFC]">
          Needs review
        </button>
        {isAdmin && (
          <details className="w-full rounded-lg border border-[#D8E6E1] bg-[#F8FAFC] text-xs text-[#334155]">
            <summary className="cursor-pointer px-3 py-2 font-semibold text-[#064E3B]">View retrieval details</summary>
            <pre className="max-h-72 overflow-auto p-3">{JSON.stringify(message.retrievalDebug || {}, null, 2)}</pre>
          </details>
        )}
      </div>
      {teaching && (
        <div className="mt-3 grid gap-2 rounded-xl border border-[#D8E6E1] bg-[#F8FAFC] p-3">
          <textarea value={correctAnswer} onChange={(event) => setCorrectAnswer(event.target.value)} placeholder="Correct answer text" className="min-h-24 rounded-lg border border-[#D8E6E1] bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#10B981]/20" />
          <div className="grid gap-2 md:grid-cols-3">
            <input value={correctSourceFile} onChange={(event) => setCorrectSourceFile(event.target.value)} placeholder="Correct source file, optional" className="rounded-lg border border-[#D8E6E1] px-3 py-2 text-sm" />
            <input value={correctFolder} onChange={(event) => setCorrectFolder(event.target.value)} placeholder="Correct folder, optional" className="rounded-lg border border-[#D8E6E1] px-3 py-2 text-sm" />
            <input value={correctModule} onChange={(event) => setCorrectModule(event.target.value)} placeholder="Correct module, optional" className="rounded-lg border border-[#D8E6E1] px-3 py-2 text-sm" />
          </div>
          <input value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Notes, optional" className="rounded-lg border border-[#D8E6E1] px-3 py-2 text-sm" />
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={saveCorrection} className="rounded-lg bg-[#047857] px-3 py-2 text-xs font-semibold text-white hover:bg-[#065F46]">Save correction</button>
            <button type="button" onClick={() => onPromptClick("Use the corrected answer I just taught you.")} className="rounded-lg border border-[#D8E6E1] bg-white px-3 py-2 text-xs font-semibold text-[#047857] hover:bg-[#F0FDF4]">Ask follow-up</button>
          </div>
        </div>
      )}
      {status && <p className="mt-2 text-xs font-semibold text-[#047857]">{status}</p>}
    </div>
  );
}

function ContextPanelCard({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[#D8E6E1] bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center gap-2 font-bold text-[#064E3B]">
        {icon}
        <h3>{title}</h3>
      </div>
      {children}
    </div>
  );
}

function MiniStatus({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-[#D8E6E1] bg-[#F8FAFC] p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-[#64748B]">{label}</p>
      <p className="mt-1 text-sm font-bold text-[#064E3B]">{value}</p>
    </div>
  );
}

function SourceBadgeCard({ source, compact = false }: { source: SourceCard; compact?: boolean }) {
  const downloadHref = source.href ? apiUrl(source.href) : "";
  const previewHref = source.previewUrl ? apiUrl(source.previewUrl) : "";
  const missingDownloadReference = source.canDownload === false || (Boolean(source.documentId || source.fileId || source.sourceFile) && !downloadHref);
  const evidence = {
    ...source,
    id: source.documentId || source.fileId || "",
    title: source.label,
    downloadUrl: source.href || "",
  };

  console.log("VISIBLE_EVIDENCE_CARD_PAYLOAD", evidence);
  console.log("VISIBLE_EVIDENCE_CARD_DOWNLOAD_STATE", {
    title: evidence.title,
    fileName: evidence.label,
    canDownload: evidence.canDownload,
    downloadUrl: evidence.downloadUrl,
    documentId: evidence.documentId,
    uploadedFileId: evidence.uploadedFileId || evidence.fileId
  });
  if (missingDownloadReference) {
    console.log("VISIBLE_EVIDENCE_CARD_UNRESOLVED", evidence);
  }
  return (
    <div className="rounded-lg border border-[#D8E6E1] bg-white p-3 shadow-sm">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
        <div className="flex min-w-0 items-start gap-2">
          <FileText size={17} className="mt-0.5 shrink-0 text-[#047857]" />
          <div className="min-w-0">
          <p className="break-words text-sm font-bold text-[#064E3B]">{source.folder ? `[${source.folder}] ` : ""}{source.label}</p>
          {!compact && (
            <div className="mt-2 grid gap-1 text-xs text-[#64748B]">
              <p>Category/Module: <span className="font-semibold text-[#334155]">{[source.category || source.folder, source.module].filter(Boolean).join(" / ") || "Not specified"}</span></p>
              <p>Section: <span className="font-semibold text-[#334155]">{source.section || "Not specified"}</span></p>
              <p>Evidence type: <span className="font-semibold text-[#334155]">{source.evidenceType || "document text"}</span></p>
              {source.fileType && <p>File type: <span className="font-semibold text-[#334155]">{source.fileType}</span></p>}
              {source.sourceFile && <p className="break-words">Source path: <span className="font-semibold text-[#334155]">{source.sourceFile}</span></p>}
              {source.detail && <p className="line-clamp-2">{source.detail}</p>}
            </div>
          )}
          </div>
        </div>
          {(downloadHref || previewHref || missingDownloadReference) && (
            <div className="grid gap-2 sm:flex sm:flex-wrap sm:justify-end">
              {downloadHref ? (
                <a href={downloadHref} className="inline-flex items-center justify-center gap-1.5 rounded-md bg-[#064E3B] px-2 py-1 text-xs font-semibold text-white hover:bg-[#047857]">
                  <Download size={12} /> Download
                </a>
              ) : missingDownloadReference ? (
                <span className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-700">Download unavailable - file could not be resolved.</span>
              ) : null}
              {previewHref && (
                <a href={previewHref} target="_blank" rel="noreferrer" className="inline-flex items-center justify-center gap-1.5 rounded-md border border-[#D8E6E1] bg-white px-2 py-1 text-xs font-semibold text-[#047857] hover:bg-[#F0FDF4]">
                  <Eye size={12} /> Preview
                </a>
              )}
            </div>
          )}
      </div>
    </div>
  );
}

function markdownComponents(role: Message["role"]) {
  return {
    a: ({ href, children, ...props }: any) => {
      const isDownload = /\/api\/documents\/(?:download|[^/]+\/download)/.test(href || "");
      return (
        <a
          href={href}
          className={isDownload
            ? "inline-flex no-underline items-center gap-1 rounded px-2 py-1 text-xs font-semibold bg-[#10B981] text-white hover:bg-[#047857]"
            : role === "user" ? "text-white underline" : "text-[#047857] underline"
          }
          {...props}
        >
          {children}
        </a>
      );
    },
    table: ({ children }: any) => (
      <div className="my-3 max-h-[420px] overflow-auto rounded-lg border border-[#D8E6E1] bg-white">
        <table className="min-w-full border-separate border-spacing-0 text-xs">{children}</table>
      </div>
    ),
    thead: ({ children }: any) => <thead className="sticky top-0 bg-[#ECFDF5]">{children}</thead>,
    th: ({ children }: any) => <th className="whitespace-nowrap border-b border-[#D8E6E1] px-3 py-2 text-left font-bold text-[#064E3B]">{children}</th>,
    td: ({ children }: any) => <td className="border-b border-[#E7F0EC] px-3 py-2 align-top">{children}</td>,
  };
}

function getDirectAnswer(content: string) {
  const withoutCharts = content.replace(/```slp-chart[\s\S]*?```/g, "").trim();
  const lines = withoutCharts.split(/\r?\n/);
  const stopIndex = lines.findIndex((line) => /^(#{1,4}\s*)?(evidence used|source files?|sources? used|suggested next questions?|actions)\b/i.test(line.replace(/\*/g, "").trim()));
  const direct = (stopIndex >= 0 ? lines.slice(0, stopIndex) : lines)
    .filter((line) => !/^\s*(source|file|folder|section|evidence type)\s*[:\-]/i.test(line.trim()))
    .join("\n")
    .trim();
  return direct || withoutCharts || "No direct answer was returned.";
}

function extractMarkdownLinks(content: string) {
  return Array.from(content.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)).map((match) => ({ label: match[1], href: match[2] }));
}

function sourceCardsFromStructuredSources(sources?: any[]): SourceCard[] {
  if (!Array.isArray(sources)) return [];
  return sources
    .filter((source) => source && (source.type === "document" || source.documentId || source.fileId || source.downloadUrl || source.file || source.fileName))
    .map((source) => {
      const fileName = source.fileName || source.originalFilename || source.file || source.filename || source.sourceFile || "Source document";
      const downloadUrl = source.downloadUrl || source.href || "";
      if ((source.documentId || source.fileId || source.sourceFile) && !downloadUrl) {
        console.log("CHAT_EVIDENCE_DOWNLOAD_MISSING", {
          fileName,
          documentId: source.documentId || source.fileId || "",
          reason: "structured source did not include downloadUrl",
        });
      }
      return {
        label: fileName,
        href: downloadUrl,
        documentId: source.documentId || "",
        uploadedFileId: source.uploadedFileId || "",
        fileId: source.fileId || "",
        originalFilename: source.originalFilename || fileName,
        storedFilename: source.storedFilename || "",
        filePath: source.filePath || "",
        storageKey: source.storageKey || "",
        folder: source.category || source.folder || source.module || "",
        category: source.category || source.folder || "",
        module: source.module || "",
        fileType: source.fileType || "",
        mimeType: source.mimeType || "",
        sourceFile: source.sourceFile || [source.category || source.folder || source.module, fileName].filter(Boolean).join("/"),
        previewUrl: source.previewUrl || "",
        canDownload: typeof source.canDownload === "boolean" ? source.canDownload : Boolean(downloadUrl),
        section: source.section || source.heading || "Not specified",
        evidenceType: source.evidenceType || source.retrievalMethod || "document text",
        detail: source.querySummary || source.detail || "",
      };
    });
}

function extractSourceCards(content: string, structuredSources?: any[]): SourceCard[] {
  const clean = content.replace(/```slp-chart[\s\S]*?```/g, "");
  const lines = clean.split(/\r?\n/);
  const links = extractMarkdownLinks(clean);
  const sourceLines = lines.filter((line) => /(source|file|folder|section|evidence|guidelines|templates|slpis|download)/i.test(line));
  const cards: SourceCard[] = sourceCardsFromStructuredSources(structuredSources);
  if (cards.length) return uniqueByLabel(cards).slice(0, 8);
  cards.push(...links
    .filter((link) => /download|source|document|file|guideline|template|\.docx|\.xlsx|\.pdf|\.csv/i.test(`${link.label} ${link.href}`))
    .map((link) => {
      const contextLine = sourceLines.find((line) => line.includes(link.label)) || "";
      return {
        label: link.label.replace(/^download\s*/i, "").trim() || "Source document",
        href: link.href,
        folder: detectFolder(`${contextLine} ${link.label}`),
        section: extractField(contextLine, "section") || extractSection(clean),
        evidenceType: extractField(contextLine, "evidence type") || "document text",
        detail: contextLine.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1").trim(),
      };
    }));

  sourceLines.forEach((line) => {
    const normalized = line.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1").replace(/^[-*\s]+/, "").trim();
    if (!normalized || /suggested next questions?|actions/i.test(normalized)) return;
    const label = extractField(normalized, "source") || extractField(normalized, "file") || extractLikelyFileName(normalized);
    if (!label) return;
    cards.push({
      label,
      folder: detectFolder(normalized),
      section: extractField(normalized, "section") || extractSection(clean),
      evidenceType: extractField(normalized, "evidence type") || (/(dashboard|analytics|table|chart)/i.test(normalized) ? "dashboard data" : "document text"),
      detail: normalized,
    });
  });

  return uniqueByLabel(cards).slice(0, 8);
}

function extractSuggestedQuestions(content: string) {
  const defaults = [
    "Show guidelines from the GUIDELINES folder",
    "List templates in the TEMPLATES folder",
    "Explain this using SLP process phases",
  ];
  const suggestedBlock = content.split(/\r?\n/);
  const extracted = suggestedBlock
    .map((line) => line.replace(/^[-*\d.\s]+/, "").trim())
    .filter((line) => line.endsWith("?") && line.length > 12)
    .slice(0, 4);
  return uniqueStrings([...extracted, ...defaults]).slice(0, 5);
}

function detectFolder(text: string) {
  return DOCUMENT_FOLDERS.find((folder) => new RegExp(folder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(text));
}

function extractField(text: string, field: string) {
  const match = text.match(new RegExp(`${field}\\s*[:\\-]\\s*([^|;]+)`, "i"));
  return match?.[1]?.trim();
}

function extractSection(text: string) {
  return text.match(/section\s*[:\-]\s*([^\n]+)/i)?.[1]?.trim() || text.match(/phase\s+(one|two|three|four|five|[1-5])[^.\n]*/i)?.[0]?.trim();
}

function extractLikelyFileName(text: string) {
  const match = text.match(/([^:|;]*\.(?:docx|xlsx|xls|pdf|csv|png|jpg|jpeg|webp))/i);
  if (match?.[1]) return match[1].trim();
  if (/guidelines|templates|slpis|proposal|monitoring/i.test(text) && text.length < 180) return text;
  return "";
}

function uniqueByLabel(cards: SourceCard[]) {
  const seen = new Set<string>();
  return cards.filter((card) => {
    const key = `${card.label}|${card.href || ""}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueStrings(items: string[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function estimateMatchingChunks(content: string) {
  const explicit = content.match(/(\d+)\s+(matching\s+)?chunks?/i)?.[1];
  if (explicit) return Number(explicit);
  const sources = extractSourceCards(content).length;
  return sources ? Math.max(1, sources) : 0;
}

type ParsedChart = {
  title: string;
  type: "bar" | "pie" | "line" | "area" | "scatter" | "kpi" | "stackedBar" | "horizontalBar";
  data: Array<Record<string, string | number>>;
  note: string;
  items?: Array<{ label: string; value: string | number }>;
  series?: Array<{ key: string; label: string }>;
  xKey?: string;
  labelKey?: string;
  valueKey?: string;
};

const CHART_COLORS = ["#10B981", "#047857", "#2563EB", "#D4AF37", "#DC2626", "#F59E0B", "#0891b2", "#4d7c0f"];

function splitMarkdownRow(line: string) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function parseMarkdownTables(content: string) {
  const lines = content.replace(/```slp-chart[\s\S]*?```/g, "").split(/\r?\n/);
  const tables: Array<{ headers: string[]; rows: string[][] }> = [];
  for (let index = 0; index < lines.length - 2; index++) {
    if (!lines[index].trim().startsWith("|") || !/^\|\s*:?-{3}/.test(lines[index + 1].trim())) continue;
    const headers = splitMarkdownRow(lines[index]);
    const rows: string[][] = [];
    index += 2;
    while (index < lines.length && lines[index].trim().startsWith("|")) {
      rows.push(splitMarkdownRow(lines[index]));
      index++;
    }
    if (headers.length && rows.length) tables.push({ headers, rows });
  }
  return tables;
}

function hasMarkdownTables(content: string) {
  return parseMarkdownTables(content).length > 0;
}

function exportMarkdownTables(content: string, format: "csv" | "xlsx") {
  const tables = parseMarkdownTables(content);
  if (!tables.length) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  if (format === "xlsx") {
    const workbook = XLSX.utils.book_new();
    tables.forEach((table, index) => {
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([table.headers, ...table.rows]), `Table ${index + 1}`);
    });
    XLSX.writeFile(workbook, `slp-analysis-${stamp}.xlsx`);
    return;
  }
  const csv = tables.map((table, index) => {
    const rows = [[`Table ${index + 1}`], table.headers, ...table.rows];
    return XLSX.utils.sheet_to_csv(XLSX.utils.aoa_to_sheet(rows));
  }).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `slp-analysis-${stamp}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function parseAssistantCharts(content: string): ParsedChart[] {
  const lines = content.split(/\r?\n/);
  const explicitCharts = Array.from(content.matchAll(/```slp-chart\s*([\s\S]*?)```/g))
    .flatMap((match) => {
      try {
        const parsed = JSON.parse(match[1]) as ParsedChart | { charts?: ParsedChart[] };
        if ("charts" in parsed && Array.isArray(parsed.charts)) return parsed.charts;
        return [parsed as ParsedChart];
      } catch {
        return [];
      }
    })
    .filter((chart) => chart?.title && chart?.type && Array.isArray(chart.data)) as ParsedChart[];
  const charts: ParsedChart[] = [...explicitCharts];

  for (let index = 0; index < lines.length; index++) {
    const heading = lines[index].match(/^\*\*(.+?)\*\*$/)?.[1] || "";
    if (!heading) continue;
    if (/^chart or table$/i.test(heading)) continue;

    const headerLine = lines[index + 1] || "";
    const dividerLine = lines[index + 2] || "";
    if (!headerLine.startsWith("|") || !/^\|\s*---/.test(dividerLine)) continue;

    const headers = splitMarkdownRow(headerLine);
    const rows: string[][] = [];
    let cursor = index + 3;

    while (cursor < lines.length && lines[cursor].startsWith("|")) {
      rows.push(splitMarkdownRow(lines[cursor]));
      cursor++;
    }

    const countHeader = headers.find((header) => /count|participant|unique|total|share|4ps|non-4ps/i.test(header));
    const labelHeader = headers.find((header) => !/bar|chart|share|count|participant|unique|total/i.test(header)) || headers[0];

    if (!countHeader || !labelHeader || rows.length < 2) continue;
    if (!/chart|trend|share|municipality|barangay|sex|year/i.test(heading)) continue;

    const labelIndex = headers.indexOf(labelHeader);
    const valueIndex = headers.indexOf(countHeader);
    const data = rows
      .map((row) => ({
        name: row[labelIndex] || "Not specified",
        value: Number(String(row[valueIndex] || "").replace(/[^0-9.-]/g, "")),
      }))
      .filter((row) => Number.isFinite(row.value) && row.value > 0)
      .slice(0, 10);

    if (data.length < 2) continue;

    const type = chooseChartType(heading, headers, data);

    charts.push({
      title: heading,
      type,
      data,
      note: chartExplanation(type, heading),
    });
  }

  return charts.slice(0, 4);
}

function chooseChartType(heading: string, headers: string[], data: Array<Record<string, string | number>>): ParsedChart["type"] {
  const text = `${heading} ${headers.join(" ")}`.toLowerCase();
  if (/trend|over time|month|date|year/.test(text)) return data.length > 4 ? "line" : "bar";
  if (/accumulated|cumulative/.test(text)) return "area";
  if (/share|type|status|4ps|non-4ps|part-to-whole/.test(text) && data.length <= 6) return "pie";
  if (/relationship|correlation|scatter/.test(text)) return "scatter";
  return "bar";
}

function chartExplanation(type: ParsedChart["type"], title: string) {
  if (type === "pie") return `Donut-style pie is used because ${title.toLowerCase()} is a small part-to-whole comparison.`;
  if (type === "line") return `Line chart is used because ${title.toLowerCase()} reads as a trend over an ordered period.`;
  if (type === "area") return `Area chart is used to emphasize accumulated movement over time.`;
  if (type === "scatter") return `Scatter plot is used to inspect a possible relationship between numeric values.`;
  return `This chart compares the categories that directly match the question.`;
}

function ChartsFromMessage({ content }: { content: string }) {
  const charts = parseAssistantCharts(content);
  if (!charts.length) return null;

  return (
    <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
      {charts.map((chart) => (
        <div key={chart.title} className="rounded-xl border border-[#D8E6E1] bg-[#F0FDF4] p-4 shadow-sm">
          <h3 className="mb-3 text-sm font-bold text-[#064E3B]">{chart.title}</h3>
          {chart.type === "kpi" ? (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {(chart.items || []).map((item) => (
                <div key={item.label} className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
                  <p className="text-xs font-medium text-slate-500">{item.label}</p>
                  <p className="mt-1 text-xl font-bold text-emerald-950">{item.value}</p>
                </div>
              ))}
            </div>
          ) : (
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              {chart.type === "pie" ? (
                <PieChart>
                  <Pie
                    data={chart.data}
                    dataKey="value"
                    nameKey="name"
                    outerRadius={82}
                    label={({ name, percent }) => `${name} ${Math.round((percent || 0) * 100)}%`}
                  >
                    {chart.data.map((_, index) => (
                      <Cell key={index} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip />
                  <Legend />
                </PieChart>
              ) : chart.type === "line" ? (
                <LineChart data={chart.data} margin={{ left: 8, right: 18, top: 8, bottom: 8 }}>
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                  <YAxis allowDecimals={false} />
                  <Tooltip />
                  <Line type="monotone" dataKey="value" stroke="#10B981" strokeWidth={3} dot={{ r: 4 }} />
                </LineChart>
              ) : chart.type === "area" ? (
                <AreaChart data={chart.data} margin={{ left: 8, right: 18, top: 8, bottom: 8 }}>
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                  <YAxis allowDecimals={false} />
                  <Tooltip />
                  <Area type="monotone" dataKey="value" stroke="#10B981" fill="#D1FAE5" />
                </AreaChart>
              ) : chart.type === "scatter" ? (
                <ScatterChart margin={{ left: 8, right: 18, top: 8, bottom: 8 }}>
                  <XAxis dataKey="name" name="Category" tick={{ fontSize: 11 }} />
                  <YAxis dataKey="value" name="Value" allowDecimals={false} />
                  <Tooltip />
                  <Scatter data={chart.data} fill="#10B981" />
                </ScatterChart>
              ) : chart.type === "stackedBar" ? (
                <BarChart data={chart.data} margin={{ left: 8, right: 18, top: 8, bottom: 8 }}>
                  <XAxis dataKey={chart.xKey || "type"} tick={{ fontSize: 11 }} />
                  <YAxis allowDecimals={false} />
                  <Tooltip />
                  <Legend />
                  {(chart.series || []).map((series, index) => (
                    <Bar key={series.key} dataKey={series.key} name={series.label} stackId="status" fill={CHART_COLORS[index % CHART_COLORS.length]} radius={index === (chart.series || []).length - 1 ? [5, 5, 0, 0] : [0, 0, 0, 0]} />
                  ))}
                </BarChart>
              ) : chart.type === "horizontalBar" ? (
                <BarChart data={chart.data} layout="vertical" margin={{ left: 20, right: 18, top: 8, bottom: 8 }}>
                  <XAxis type="number" allowDecimals={false} />
                  <YAxis type="category" dataKey={chart.labelKey || "name"} width={140} tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Bar dataKey={chart.valueKey || "value"} fill="#10B981" radius={[0, 5, 5, 0]} />
                </BarChart>
              ) : (
                <BarChart data={chart.data} layout="vertical" margin={{ left: 16, right: 12, top: 8, bottom: 8 }}>
                  <XAxis type="number" allowDecimals={false} />
                  <YAxis type="category" dataKey="name" width={112} tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Bar dataKey="value" fill="#10B981" radius={[0, 5, 5, 0]} />
                </BarChart>
              )}
            </ResponsiveContainer>
          </div>
          )}
          <p className="mt-3 text-xs text-[#64748B]">{chart.note}</p>
        </div>
      ))}
    </div>
  );
}

// ================= DOCUMENTS =================
function Documents({
  profile,
  docs,
  setDocs,
  isLoaded,
  isLoading,
  error,
  loadDocs,
  onFilesChanged,
}: {
  profile: Profile | null;
  docs: any[];
  setDocs: React.Dispatch<React.SetStateAction<any[]>>;
  isLoaded: boolean;
  isLoading: boolean;
  error: string;
  lastLoadedAt: number;
  loadDocs: (reason: string, options?: { force?: boolean }) => Promise<any[]>;
  onFilesChanged: (reason: string) => Promise<void>;
}) {
  const [files, setFiles] = useState<FileList | null>(null);
  const [folder, setFolder] = useState("SLPIS");
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState("");
  const [reclassifying, setReclassifying] = useState(false);
  const [editingClassificationId, setEditingClassificationId] = useState<string | null>(null);
  const [classificationDraft, setClassificationDraft] = useState({ documentType: "", documentPurpose: "", keywords: "" });
  const isAdmin = profile?.role === "admin" && profile.status === "approved";
  const uploadFolderButtonLabel =
    folder === "SLPIS" ? "Upload SLPIS Folder" :
    folder === "PROPOSALS" ? "Upload Proposal Folder" :
    folder === "SLP DPT" ? "Upload SLP DPT Folder" :
    "Upload Folder";

  useEffect(() => {
    loadDocs("documents opened");
  }, [loadDocs]);

  const upload = async () => {
    if (!files) return;

    setUploading(true);
    const selectedFolder = folder;
    const uploadMode = selectedFolder === "PROPOSALS" ? "proposal-folder" : "documents-folder";
    const endpoint = selectedFolder === "PROPOSALS" ? "/api/proposals/upload-folder" : "/api/upload-document";
    setMessage(selectedFolder === "PROPOSALS" ? "Uploading and scanning proposal folder..." : `Uploading folder to ${selectedFolder}...`);

    try {
      const selectedFiles = Array.from(files);
      const roots = Array.from(new Set(selectedFiles.map((file) => (file as File & { webkitRelativePath?: string }).webkitRelativePath?.split("/")[0] || "").filter(Boolean)));
      console.log("[DOCUMENT_FOLDER_UPLOAD_START]", {
        selectedFolder,
        uploadMode,
        endpoint,
        filesReceived: selectedFiles.map((file) => ({
          fileName: file.name,
          fileSize: file.size,
          relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || "",
        })),
      });

      if (selectedFolder === "PROPOSALS" && roots.length !== 1) {
        throw new Error("Choose exactly one complete proposal folder at a time.");
      }

      const payloadFiles = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || "";
        if (!relativePath) throw new Error("Folder upload requires a browser directory selection.");
        const dataUrl = await readFileAsDataUrl(file);
        payloadFiles.push({
          fileName: file.name,
          fileType: file.type || "application/octet-stream",
          fileSize: file.size,
          relativePath,
          data: dataUrl.split(",")[1],
        });
      }

      if (selectedFolder === "PROPOSALS") {
        const res = await apiFetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ files: payloadFiles, userId: profile?.id, selectedFolder, uploadMode }),
        });
        const data = await readJsonResponse(res);

        setFiles(null);
        setMessage(`Proposal folder uploaded: ${data.originalFolderName}. Detected ${data.detectedDocuments?.length || 0} proposal document(s) and ${data.extractedItems?.length || 0} item(s).`);
        console.log("[DOCUMENT_FOLDER_UPLOAD_COMPLETE]", {
          selectedFolder,
          uploadMode,
          endpoint,
          filesReceived: payloadFiles.length,
          finalSavedFolder: "PROPOSALS",
        });
        await onFilesChanged("proposal folder upload succeeded");
        return;
      }

      const uploadedDocuments = [];
      for (const file of payloadFiles) {
        const res = await apiFetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...file,
            folder: selectedFolder,
            selectedFolder,
            uploadMode,
            userId: profile?.id,
          }),
        });
        const data = await readJsonResponse(res);
        uploadedDocuments.push(data.document);
      }

      setFiles(null);
      setMessage(`Uploaded ${uploadedDocuments.length} file${uploadedDocuments.length === 1 ? "" : "s"} to ${selectedFolder}.`);
      console.log("[DOCUMENT_FOLDER_UPLOAD_COMPLETE]", {
        selectedFolder,
        uploadMode,
        endpoint,
        filesReceived: payloadFiles.length,
        finalSavedFolder: selectedFolder,
      });
      await onFilesChanged(`${selectedFolder} folder upload succeeded`);
    } catch (error: any) {
      setMessage(error.message);
    } finally {
      setUploading(false);
    }
  };

  const deleteDoc = async (doc: any) => {
    const confirmed = window.confirm(`Delete ${doc.file_name}?`);
    if (!confirmed) return;

    setDeletingId(doc.id);
    setMessage("");

    try {
      const res = await apiFetch(`/api/documents/${encodeURIComponent(doc.id)}?userId=${encodeURIComponent(profile?.id || "")}`, {
        method: "DELETE"
      });
      const data = await readJsonResponse(res);

      if (!res.ok) {
        throw new Error(data.error || "Delete failed.");
      }

      setDocs((current) => current.filter((item) => item.id !== doc.id));
      setSelectedDocIds((current) => {
        const next = new Set(current);
        next.delete(doc.id);
        return next;
      });
      setMessage("Document deleted.");
      await onFilesChanged("file delete succeeded");
    } catch (error: any) {
      setMessage(error.message);
    } finally {
      setDeletingId(null);
    }
  };

  const parseListField = (value: any) => {
    if (Array.isArray(value)) return value.join(", ");
    try {
      const parsed = JSON.parse(String(value || "[]"));
      return Array.isArray(parsed) ? parsed.join(", ") : "";
    } catch {
      return String(value || "");
    }
  };

  const startClassificationEdit = (doc: any) => {
    setEditingClassificationId(doc.id);
    setClassificationDraft({
      documentType: doc.document_type || "",
      documentPurpose: doc.document_purpose || "",
      keywords: parseListField(doc.keywords),
    });
  };

  const saveClassification = async (doc: any) => {
    setMessage("Saving classification override...");
    try {
      const res = await apiFetch(`/api/admin/document-classifications/${encodeURIComponent(doc.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: profile?.id,
          documentType: classificationDraft.documentType,
          documentPurpose: classificationDraft.documentPurpose,
          keywords: classificationDraft.keywords,
          relatedTopics: parseListField(doc.related_topics),
        }),
      });
      const data = await readJsonResponse(res);
      if (!res.ok) throw new Error(data.error || "Classification update failed.");
      setEditingClassificationId(null);
      setMessage("Classification override saved.");
      await loadDocs("classification override saved", { force: true });
    } catch (error: any) {
      setMessage(error.message);
    }
  };

  const reclassifyDocuments = async () => {
    setReclassifying(true);
    setMessage("Reclassifying uploaded documents...");
    try {
      const res = await apiFetch("/api/admin/reclassify-documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: profile?.id }),
      });
      const data = await readJsonResponse(res);
      if (!res.ok) throw new Error(data.error || "Reclassification failed.");
      setMessage(`Reclassified ${data.updated || 0} document${data.updated === 1 ? "" : "s"}.`);
      await onFilesChanged("manual reprocess succeeded");
    } catch (error: any) {
      setMessage(error.message);
    } finally {
      setReclassifying(false);
    }
  };

  const filteredDocs = docs.filter((doc) => doc.folder === folder);
  const selectedVisibleDocs = filteredDocs.filter((doc) => selectedDocIds.has(doc.id));
  const allVisibleSelected = filteredDocs.length > 0 && selectedVisibleDocs.length === filteredDocs.length;

  const toggleDocSelection = (docId: string) => {
    setSelectedDocIds((current) => {
      const next = new Set(current);
      if (next.has(docId)) next.delete(docId);
      else next.add(docId);
      return next;
    });
  };

  const toggleVisibleSelection = () => {
    setSelectedDocIds((current) => {
      const next = new Set(current);
      if (allVisibleSelected) filteredDocs.forEach((doc) => next.delete(doc.id));
      else filteredDocs.forEach((doc) => next.add(doc.id));
      return next;
    });
  };

  const deleteSelectedDocs = async () => {
    if (!selectedVisibleDocs.length) return;
    const confirmed = window.confirm(`Delete ${selectedVisibleDocs.length} selected file${selectedVisibleDocs.length === 1 ? "" : "s"} from ${folder}?`);
    if (!confirmed) return;

    setDeletingId("bulk");
    setMessage(`Deleting ${selectedVisibleDocs.length} selected file${selectedVisibleDocs.length === 1 ? "" : "s"}...`);

    const deletedIds = new Set<string>();
    try {
      for (const doc of selectedVisibleDocs) {
        const res = await apiFetch(`/api/documents/${encodeURIComponent(doc.id)}?userId=${encodeURIComponent(profile?.id || "")}`, {
          method: "DELETE"
        });
        const data = await readJsonResponse(res);

        if (!res.ok) {
          throw new Error(data.error || `Delete failed for ${doc.file_name}.`);
        }
        deletedIds.add(doc.id);
      }

      setDocs((current) => current.filter((item) => !deletedIds.has(item.id)));
      setSelectedDocIds((current) => {
        const next = new Set(current);
        deletedIds.forEach((id) => next.delete(id));
        return next;
      });
      setMessage(`Deleted ${deletedIds.size} selected file${deletedIds.size === 1 ? "" : "s"}.`);
      await onFilesChanged("bulk file delete succeeded");
    } catch (error: any) {
      setDocs((current) => current.filter((item) => !deletedIds.has(item.id)));
      setSelectedDocIds((current) => {
        const next = new Set(current);
        deletedIds.forEach((id) => next.delete(id));
        return next;
      });
      setMessage(error.message);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div>
      {/* Header */}
      <div className="mb-8">
        <h2 className="text-3xl font-bold text-[#064E3B] mb-2">Documents</h2>
        <p className="text-[#64748B]">Manage your knowledge base files - showing {filteredDocs.length} file{filteredDocs.length === 1 ? "" : "s"} in {folder}</p>
      </div>

      {!isAdmin && (
        <div className="mb-6 rounded-lg bg-blue-50 border border-blue-200 px-4 py-3">
          <p className="text-sm text-blue-800">
            <strong>Note:</strong> Document uploads are admin-only. You can attach files directly in chat for analysis.
          </p>
        </div>
      )}

      {/* Controls */}
      <div className="mb-6 grid gap-3 xl:grid-cols-[minmax(240px,1fr)_220px_auto]">
        <div className="flex min-h-11 items-center gap-2 rounded-lg border border-[#D8E6E1] bg-white px-4 py-2">
          <Search size={20} className="text-[#64748B]" />
          <input
            type="text"
            placeholder="Search documents..."
            className="flex-1 outline-none text-sm"
          />
        </div>

        <select
          value={folder}
          onChange={(event) => {
            setFolder(event.target.value);
            setSelectedDocIds(new Set());
          }}
          className="min-h-11 rounded-lg border border-[#D8E6E1] bg-white px-4 py-2 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-[#10B981]"
          title="Choose upload folder"
        >
          {DOCUMENT_FOLDERS.map((item) => (
            <option key={item} value={item}>{item}</option>
          ))}
        </select>

        <button
          onClick={() => loadDocs("manual files refresh", { force: true })}
          disabled={isLoading}
          className="flex min-h-11 items-center justify-center gap-2 rounded-lg border border-[#D8E6E1] bg-white px-4 py-2 font-medium text-[#064E3B] transition-colors hover:bg-[#F0FDF4] disabled:opacity-50"
          title="Refresh documents"
        >
          <RefreshCw size={18} className={isLoading ? "animate-spin" : ""} />
          {isLoading && isLoaded ? "Refreshing..." : "Refresh"}
        </button>

        {isAdmin && (
          <>
            <div className="flex min-h-11 items-center gap-2 rounded-lg border border-[#D8E6E1] bg-white px-4 py-2 xl:col-span-2">
              <Upload size={20} className="text-[#64748B]" />
              <input
                className="outline-none text-sm file:hidden"
                type="file"
                {...({ webkitdirectory: "", directory: "" } as any)}
                multiple
                accept=".csv,.xlsx,.xls,.pdf,.png,.jpg,.jpeg,.webp,.docx,text/csv,application/pdf,image/png,image/jpeg,image/webp"
                onChange={(e) => setFiles(e.target.files)}
              />
              <span className="text-sm text-[#64748B]">{files?.length ? `${files.length} file(s) selected` : `Choose ${folder} folder...`}</span>
            </div>
            <button
              onClick={upload}
              disabled={uploading || !files}
              className="flex min-h-11 items-center justify-center gap-2 rounded-lg bg-[#047857] px-4 py-2 font-medium text-white transition-colors hover:bg-[#065F46] disabled:opacity-50"
              title={uploadFolderButtonLabel}
            >
              <Upload size={18} />
              {uploadFolderButtonLabel}
            </button>
            <button
              onClick={reclassifyDocuments}
              disabled={reclassifying}
              className="flex min-h-11 items-center justify-center gap-2 rounded-lg border border-[#D8E6E1] bg-white px-4 py-2 font-medium text-[#064E3B] transition-colors hover:bg-[#F0FDF4] disabled:opacity-50"
              title="Reclassify existing uploaded documents"
            >
              <RefreshCw size={18} className={reclassifying ? "animate-spin" : ""} />
              Reclassify
            </button>
            {selectedVisibleDocs.length > 0 && (
              <button
                onClick={deleteSelectedDocs}
                disabled={deletingId === "bulk"}
                className="flex min-h-11 items-center justify-center gap-2 rounded-lg bg-[#DC2626] px-4 py-2 font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
                title="Delete selected documents"
              >
                <Trash2 size={18} />
                Delete ({selectedVisibleDocs.length})
              </button>
            )}
          </>
        )}
      </div>

      {/* Table */}
      <div className="slp-table-wrap">
        <table className="slp-table min-w-[1120px]">
          <thead>
            <tr>
              {isAdmin && (
                <th className="w-10 px-3 py-3">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    disabled={!filteredDocs.length || deletingId === "bulk"}
                    onChange={toggleVisibleSelection}
                    className="h-4 w-4 rounded border-[#D8E6E1] text-[#047857] focus:ring-[#10B981]"
                    title="Select all visible documents"
                  />
                </th>
              )}
              <th>File Name</th>
              <th>Folder</th>
              <th>Owner</th>
              <th>Classification</th>
              <th>Date</th>
              <th>Status</th>
              {isAdmin && <th className="text-center">Action</th>}
            </tr>
          </thead>
          <tbody>
            {filteredDocs.length === 0 ? (
              <tr>
                <td colSpan={isAdmin ? 8 : 6} className="p-6">
                  <div className="slp-empty-state space-y-2">
                    <p className="font-medium">No files in {folder} yet</p>
                    <p className="text-sm">Upload files to get started with document analysis</p>
                  </div>
                </td>
              </tr>
            ) : (
              filteredDocs.map((d) => (
                <tr key={d.id}>
                  {isAdmin && (
                    <td className="text-center">
                      <input
                        type="checkbox"
                        checked={selectedDocIds.has(d.id)}
                        disabled={deletingId === "bulk" || deletingId === d.id}
                        onChange={() => toggleDocSelection(d.id)}
                        className="h-4 w-4 rounded border-[#D8E6E1] text-[#047857] focus:ring-[#10B981]"
                        title={`Select ${d.file_name}`}
                      />
                    </td>
                  )}
                  <td className="font-medium text-[#0F172A]">{d.file_name}</td>
                  <td>{d.folder}</td>
                  <td className="text-xs">{d.uploaded_by === profile?.id ? "You" : d.uploaded_by || "-"}</td>
                  <td className="max-w-xs text-xs">
                    {editingClassificationId === d.id ? (
                      <div className="space-y-2">
                        <input
                          value={classificationDraft.documentType}
                          onChange={(event) => setClassificationDraft((current) => ({ ...current, documentType: event.target.value }))}
                          className="w-full rounded border border-[#D8E6E1] px-2 py-1"
                          placeholder="DOCUMENT_TYPE"
                        />
                        <textarea
                          value={classificationDraft.documentPurpose}
                          onChange={(event) => setClassificationDraft((current) => ({ ...current, documentPurpose: event.target.value }))}
                          className="w-full rounded border border-[#D8E6E1] px-2 py-1"
                          rows={2}
                          placeholder="Purpose"
                        />
                        <input
                          value={classificationDraft.keywords}
                          onChange={(event) => setClassificationDraft((current) => ({ ...current, keywords: event.target.value }))}
                          className="w-full rounded border border-[#D8E6E1] px-2 py-1"
                          placeholder="Keywords"
                        />
                        <div className="flex gap-2">
                          <button onClick={() => saveClassification(d)} className="inline-flex items-center gap-1 rounded bg-[#047857] px-2 py-1 text-white" title="Save classification">
                            <Save size={14} />
                            Save
                          </button>
                          <button onClick={() => setEditingClassificationId(null)} className="rounded border border-[#D8E6E1] px-2 py-1 text-[#475569]">
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-1">
                        <div className="font-bold text-[#064E3B]">{d.document_type || "Unclassified"}</div>
                        <div className="line-clamp-2">{d.document_purpose || "No purpose detected yet."}</div>
                        <div className="text-[#64748B]">Confidence: {Math.round(Number(d.classification_confidence || 0))}% · Download: {d.download_available ? "yes" : "no"}</div>
                        {d.classification_override ? <div className="text-[#047857]">Admin override</div> : null}
                        {isAdmin && (
                          <button onClick={() => startClassificationEdit(d)} className="text-[#047857] hover:underline">
                            Review / edit
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                  <td>
                    {new Date(d.created_at).toLocaleDateString()}
                  </td>
                  <td>
                    <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-[#D1FAE5] text-xs font-bold text-[#047857]">
                      <div className="w-2 h-2 bg-[#10B981] rounded-full"></div>
                      Indexed
                    </span>
                  </td>
                  {isAdmin && (
                    <td className="text-center">
                      <button
                        onClick={() => deleteDoc(d)}
                        disabled={deletingId === d.id}
                        className="text-[#DC2626] hover:text-red-700 disabled:opacity-50 transition-colors"
                        title="Delete document"
                      >
                        <Trash2 size={20} />
                      </button>
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Messages */}
      {isLoading && !isLoaded && (
        <div className="mt-4 rounded-lg bg-green-50 px-4 py-3 text-sm text-green-800">
          Loading documents...
        </div>
      )}
      {isLoading && isLoaded && (
        <div className="mt-4 rounded-lg bg-green-50 px-4 py-3 text-sm text-green-800">
          Refreshing documents...
        </div>
      )}
      {uploading && (
        <div className="mt-4 rounded-lg bg-green-50 px-4 py-3 text-sm text-green-800">
          Uploading and processing documents...
        </div>
      )}
      {error && (
        <div className="mt-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {error}
        </div>
      )}
      {message && (
        <div className={`mt-4 rounded-lg px-4 py-3 text-sm ${
          message.includes("success") || message.includes("complete") || message.includes("complete.")
            ? "bg-green-50 text-green-800"
            : "bg-red-50 text-red-800"
        }`}>
          {message}
        </div>
      )}
    </div>
  );
}

type MatchResult = {
  row?: number;
  name: string;
  fullName?: string;
  status: string;
  classification?: string;
  duplicate: boolean;
  matchedDocuments: string[];
  matchedRow?: number | string;
  bestMatch?: string;
  matchedName?: string;
  confidence?: string;
  matchPercentage?: string;
  score?: number;
  duplicateType?: string;
  notes?: string;
  sourceSystem?: string;
  sourceModule?: string;
  sourceFile?: string;
  sourceRowNumber?: number | string;
  sourceId?: string;
  slpParticipantId?: string;
  slpUniqueId?: string;
  fundSource?: string;
  isPantawid?: string;
  pantawidStatus?: string;
  householdId?: string;
  typeOfParticipant?: string;
  municipality?: string;
  barangay?: string;
  explanation?: string;
  whyMatched?: string;
  overrideKey?: string;
  userDecision?: string;
  userConfirmed?: boolean;
};

function NameMatching() {
  const [file, setFile] = useState<File | null>(null);
  const [typedNames, setTypedNames] = useState("");
  const [results, setResults] = useState<any[]>([]);
  const [sourceSummary, setSourceSummary] = useState<any>(null);
  const [progress, setProgress] = useState<any>(null);
  const [message, setMessage] = useState("");
  const [matching, setMatching] = useState(false);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [history, setHistory] = useState<any[]>([]);
  const jobIdRef = useRef<string>(localStorage.getItem("slp-match-job-id") || "");
  const pageSize = 25;

  const loadSourceSummary = useCallback(async () => {
    try {
      const res = await apiFetch("/api/match/reference-summary", { cache: "no-store" }, { endpointName: "Match reference summary" });
      const data = await readJsonResponse(res);
      setSourceSummary(data);
    } catch (error: any) {
      setMessage(error.message || "Could not load reference source summary.");
    }
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const res = await apiFetch("/api/match/history", { cache: "no-store" }, { endpointName: "Match history" });
      const data = await readJsonResponse(res);
      setHistory(data.jobs || []);
    } catch {
      setHistory([]);
    }
  }, []);

  const loadJob = useCallback(async (jobId: string, includeResults = false) => {
    if (!jobId) return;
    const endpoint = includeResults ? `/api/match/results/${jobId}` : `/api/match/progress/${jobId}`;
    const res = await apiFetch(endpoint, { cache: "no-store" }, { endpointName: "Match progress" });
    const data = await readJsonResponse(res);
    const nextProgress = data.progress;
    setProgress(nextProgress);
    setMatching(nextProgress?.status === "running" || nextProgress?.status === "queued");
    if (data.results) setResults(data.results || []);
    if (nextProgress?.sourceSummary) setSourceSummary(nextProgress.sourceSummary);
    if (["completed", "cancelled", "failed"].includes(nextProgress?.status)) {
      const resultsRes = includeResults ? data : await readJsonResponse(await apiFetch(`/api/match/results/${jobId}`, { cache: "no-store" }, { endpointName: "Match results" }));
      setResults(resultsRes.results || []);
      setMatching(false);
      setStep(3);
      loadHistory().catch(() => undefined);
    }
  }, [loadHistory]);

  useEffect(() => {
    loadSourceSummary();
    loadHistory();
    const savedJobId = jobIdRef.current;
    if (savedJobId) loadJob(savedJobId, true).catch(() => localStorage.removeItem("slp-match-job-id"));
  }, [loadHistory, loadJob, loadSourceSummary]);

  useEffect(() => {
    if (!jobIdRef.current || !matching) return;
    const timer = window.setInterval(() => loadJob(jobIdRef.current, false).catch((error) => setMessage(error.message)), 1500);
    return () => window.clearInterval(timer);
  }, [loadJob, matching]);

  const runMatch = async () => {
    if (!file && !typedNames.trim()) return;

    setMatching(true);
    setMessage("Starting Deep Accuracy matching job...");
    setResults([]);
    setProgress(null);
    setStep(3);

    try {
      const dataUrl = file ? await readFileAsDataUrl(file) : "";
      const typed = typedNames.split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
      const res = await apiFetch("/api/match/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inputRecords: [],
          typedNames: typed,
          referenceSources: ["SLP_DPT", "SLPIS_PERSONAL"],
          mode: "deep_accuracy",
          fileName: file?.name,
          fileType: file?.type || "application/octet-stream",
          data: dataUrl ? dataUrl.split(",")[1] : "",
          names: ""
        })
      });
      const data = await readJsonResponse(res);
      jobIdRef.current = data.jobId;
      localStorage.setItem("slp-match-job-id", data.jobId);
      setSourceSummary(data.sourceSummary);
      setMessage("Deep Accuracy matching is running in the backend.");
      loadHistory().catch(() => undefined);
      await loadJob(data.jobId);
    } catch (error: any) {
      setMessage(error.message);
      setMatching(false);
    }
  };

  const resetCurrentBatchView = (nextMessage: string) => {
    setFile(null);
    setTypedNames("");
    setResults([]);
    setProgress(null);
    setMatching(false);
    setExpanded(null);
    setPage(1);
    setStep(1);
    jobIdRef.current = "";
    localStorage.removeItem("slp-match-job-id");
    setMessage(nextMessage);
    loadSourceSummary().catch(() => undefined);
    loadHistory().catch(() => undefined);
  };

  const startNewBatch = () => {
    resetCurrentBatchView("Ready for a new matching batch.");
  };

  const clearCurrentBatch = () => {
    const confirmed = window.confirm("Clear the current batch from this screen? Saved completed results will remain in history.");
    if (!confirmed) return;
    resetCurrentBatchView("Current batch cleared from this screen. Saved completed results remain in history.");
  };

  const goBackInMatchFlow = () => {
    if (expanded) {
      setExpanded(null);
      return;
    }
    if (step === 3) {
      setStep(1);
      setMatching(false);
      setMessage("");
      return;
    }
    if (step === 2) setStep(1);
  };

  const normalizeAddressPart = (value: any) => String(value || "").trim().toLowerCase();
  const addressMatchStatus = (row: any) => {
    const inputMunicipality = normalizeAddressPart(row.inputMunicipality);
    const inputBarangay = normalizeAddressPart(row.inputBarangay);
    const matchedMunicipality = normalizeAddressPart(row.municipality);
    const matchedBarangay = normalizeAddressPart(row.barangay);
    if (!inputMunicipality && !inputBarangay) return "Input address missing";
    if (!matchedMunicipality && !matchedBarangay) return "Matched address missing";
    if (inputMunicipality && matchedMunicipality && inputMunicipality !== matchedMunicipality) return "Different municipality";
    if (inputMunicipality && matchedMunicipality && inputMunicipality === matchedMunicipality && inputBarangay && matchedBarangay && inputBarangay === matchedBarangay) return "Same municipality and barangay";
    if (inputMunicipality && matchedMunicipality && inputMunicipality === matchedMunicipality) return "Same municipality only";
    if (!inputMunicipality || !inputBarangay) return "Input address missing";
    if (!matchedMunicipality || !matchedBarangay) return "Matched address missing";
    return "Different municipality";
  };

  const addressWarnings = (row: any) => {
    const warnings: string[] = [];
    const inputMunicipality = normalizeAddressPart(row.inputMunicipality);
    const matchedMunicipality = normalizeAddressPart(row.municipality);
    const inputBarangay = normalizeAddressPart(row.inputBarangay);
    const matchedBarangay = normalizeAddressPart(row.barangay);
    if (inputMunicipality && matchedMunicipality && inputMunicipality !== matchedMunicipality) warnings.push("Municipality differs");
    if (inputBarangay && matchedBarangay && inputBarangay !== matchedBarangay) warnings.push("Barangay differs");
    return warnings;
  };

  const resultExportRows = (rows: any[]) => rows.map((row) => ({
      "Input Name": row.inputName || "",
      "Input Municipality": row.inputMunicipality || "",
      "Input Barangay": row.inputBarangay || "",
      "Matched Name": row.matchedName || "",
      Source: row.source || "",
      Score: row.finalScore || 0,
      Category: row.category || "",
      "Match Reason": row.reason || "",
      "Matched Municipality": row.municipality || "",
      "Matched Barangay": row.barangay || "",
      "SLP Participant ID": row.slpParticipantId || "",
      "Pantawid Status": row.pantawidStatus || "",
      "Household ID": row.householdId || "",
      "SLP Unique ID": row.slpUniqueId || "",
      "Fund Source": row.fundSource || "",
      "Type of Participant": row.typeOfParticipant || "",
      "Top Candidates": JSON.stringify(row.topCandidates || [])
    }));

  const downloadExcel = (rows = results, fileName = "deep-match-results.xlsx") => {
    const exportRows = resultExportRows(rows);
    const worksheet = XLSX.utils.json_to_sheet(exportRows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Deep Match Results");
    XLSX.writeFile(workbook, fileName);
  };

  const downloadCsv = (rows = results, fileName = "deep-match-results.csv") => {
    const worksheet = XLSX.utils.json_to_sheet(resultExportRows(rows));
    const csv = XLSX.utils.sheet_to_csv(worksheet);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const viewHistoryResults = async (jobId: string) => {
    jobIdRef.current = jobId;
    localStorage.setItem("slp-match-job-id", jobId);
    setExpanded(null);
    setPage(1);
    setStep(3);
    await loadJob(jobId, true);
  };

  const exportHistoryResults = async (jobId: string) => {
    const data = await readJsonResponse(await apiFetch(`/api/match/results/${jobId}`, { cache: "no-store" }, { endpointName: "Match results export" }));
    downloadExcel(data.results || [], `deep-match-results-${jobId}.xlsx`);
  };

  const saveFeedback = async (row: any, feedback: "correct" | "wrong" | "not_sure" | "manual_link") => {
    try {
      const correctedRecordId = feedback === "manual_link" ? prompt("Enter SLP Participant ID or SLP UNIQUE ID to link manually:", row.slpParticipantId || row.slpUniqueId || "") || "" : "";
      const res = await apiFetch("/api/match/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inputName: row.inputName,
          matchedName: row.matchedName,
          source: row.source,
          feedback,
          correctedRecordId,
          notes: row.reason || ""
        })
      });
      const data = await readJsonResponse(res);
      if (!res.ok) throw new Error(data.error || "Could not save match feedback.");
      setMessage("Match feedback saved.");
    } catch (error: any) {
      setMessage(error.message);
    }
  };

  const cancelJob = async () => {
    if (!jobIdRef.current) return;
    await apiFetch(`/api/match/cancel/${jobIdRef.current}`, { method: "POST" }, { endpointName: "Cancel match job" });
    await loadJob(jobIdRef.current, true);
  };

  const pagedResults = results.slice((page - 1) * pageSize, page * pageSize);
  const pageCount = Math.max(1, Math.ceil(results.length / pageSize));
  const estimatedLong = Number(progress?.estimatedRemainingMs || 0) > 30 * 60 * 1000;
  const terminalStatus = ["completed", "cancelled", "failed"].includes(progress?.status || "");
  const showBackButton = step === 2 || step === 3 || Boolean(expanded);
  const showNewBatchButton = terminalStatus || results.length > 0;
  const completedHistory = history.filter((job) => ["completed", "cancelled", "failed"].includes(job.status));

  return (
    <div>
      <div className="mb-8 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h2 className="text-3xl font-bold text-[#064E3B] mb-2">Match & Compare</h2>
          <p className="text-[#64748B]">Deep Accuracy matching against SLP DPT and SLPIS Personal Module only.</p>
        </div>
        {(showBackButton || showNewBatchButton) && (
          <div className="flex flex-wrap gap-2">
            {showBackButton && (
              <button onClick={goBackInMatchFlow} className="px-4 py-2 rounded-lg border border-[#D8E6E1] text-[#047857] hover:bg-[#F0FDF4] font-medium">
                Back
              </button>
            )}
            {showNewBatchButton && (
              <button onClick={startNewBatch} className="px-4 py-2 rounded-lg bg-[#047857] text-white hover:bg-[#065F46] font-medium">
                New Batch
              </button>
            )}
          </div>
        )}
      </div>

      {results.length === 0 && (
        <div className="flex gap-4 mb-8">
          <StepIndicator step={1} currentStep={step} label="Add Names" />
          <StepIndicator step={2} currentStep={step} label="Review Sources" />
          <StepIndicator step={3} currentStep={step} label="Results" />
        </div>
      )}

      {step === 1 && (
        <div className="bg-white rounded-xl border border-[#D8E6E1] p-6 shadow-sm">
          <h3 className="text-lg font-bold text-[#064E3B] mb-4">Step 1: Add Names to Match</h3>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-[#064E3B] mb-2">Type Names (one per line)</label>
              <textarea
                className="w-full h-40 border border-[#D8E6E1] rounded-lg p-4 focus:outline-none focus:ring-2 focus:ring-[#10B981] focus:border-transparent resize-none"
                placeholder="Example:&#10;DELA CRUZ, JUAN&#10;SANTOS, MARIA&#10;REYES, CARLOS"
                value={typedNames}
                onChange={(event) => setTypedNames(event.target.value)}
              />
              <p className="text-sm text-[#64748B] mt-2">Or upload an Excel or CSV file instead</p>
            </div>

            <div className="flex items-center gap-2 p-4 rounded-lg border-2 border-dashed border-[#D8E6E1]">
              <Upload size={24} className="text-[#64748B]" />
              <input
                className="flex-1 outline-none"
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={(event) => setFile(event.target.files?.[0] || null)}
              />
              {file && <span className="text-sm font-medium text-[#10B981]">✓ {file.name}</span>}
            </div>

            <button
              onClick={() => setStep(2)}
              disabled={!file && !typedNames.trim()}
              className="w-full px-6 py-3 bg-[#047857] text-white rounded-lg hover:bg-[#065F46] disabled:opacity-50 font-medium transition-colors"
            >
              Continue to Options
            </button>
          </div>
        </div>
      )}

      {step === 1 && completedHistory.length > 0 && (
        <div className="mt-6 bg-white rounded-xl border border-[#D8E6E1] p-6 shadow-sm">
          <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <h3 className="text-base font-bold text-[#064E3B]">Previous Batches</h3>
              <p className="text-sm text-[#64748B]">Saved completed and cancelled Match & Compare jobs remain available here.</p>
            </div>
            <button onClick={startNewBatch} className="px-4 py-2 rounded-lg bg-[#047857] text-white hover:bg-[#065F46] font-medium">
              New Batch
            </button>
          </div>
          <div className="slp-table-wrap">
            <table className="slp-table min-w-[900px]">
              <thead>
                <tr>
                  {["Date / Time", "Total Names", "Exact", "Possible", "Weak", "No Match", "Status", "Actions"].map((header) => (
                    <th key={header}>{header}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {completedHistory.map((job) => (
                  <tr key={job.jobId}>
                    <td className="text-[#0F172A]">{new Date(job.completedAt || job.cancelledAt || job.updatedAt || job.startedAt).toLocaleString()}</td>
                    <td>{job.total || 0}</td>
                    <td>{job.exactCount || 0}</td>
                    <td>{job.possibleCount || 0}</td>
                    <td>{job.weakCount || 0}</td>
                    <td>{job.noMatchCount || 0}</td>
                    <td>
                      <span className="rounded-full bg-slate-50 px-2 py-1 text-xs font-bold text-slate-700">{job.status}</span>
                    </td>
                    <td>
                      <div className="flex gap-2">
                        <button onClick={() => viewHistoryResults(job.jobId)} className="px-3 py-2 rounded-lg border border-[#D8E6E1] text-[#047857] hover:bg-[#F0FDF4] font-medium">View Results</button>
                        <button onClick={() => exportHistoryResults(job.jobId)} className="px-3 py-2 rounded-lg border border-[#D8E6E1] text-[#047857] hover:bg-[#F0FDF4] font-medium">Export</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="bg-white rounded-xl border border-[#D8E6E1] p-6 shadow-sm">
          <h3 className="text-lg font-bold text-[#064E3B] mb-4">Step 2: Reference Source Summary</h3>
          <div className="grid gap-4 md:grid-cols-3 mb-6">
            <ResultCard label="SLP DPT reference records loaded" value={sourceSummary?.slpDptReferenceRecords || 0} icon="DPT" />
            <ResultCard label="SLPIS Personal Module records loaded" value={sourceSummary?.slpisPersonalReferenceRecords || 0} icon="PM" />
            <ResultCard label="Other modules ignored" value={sourceSummary?.otherModulesIgnored ? "Yes" : "No"} icon="Strict" />
          </div>
          <div className="space-y-3 mb-6">
            <div className="rounded-lg bg-[#F0FDF4] border border-[#D8E6E1] p-4 text-sm text-[#064E3B]">
              Deep Accuracy Mode is enabled by default. Matching runs in the backend and uses actual Levenshtein distance, token-set similarity, context scoring, and strict source evidence.
            </div>
            {(sourceSummary?.slpDptReferenceRecords || 0) === 0 && (sourceSummary?.slpisPersonalReferenceRecords || 0) === 0 && (
              <div className="rounded-lg bg-red-50 border border-red-200 p-4 text-sm font-medium text-red-700">
                Reference sources are missing. Please upload or process SLP DPT and SLPIS Personal Module first.
              </div>
            )}
            {((sourceSummary?.slpDptReferenceRecords || 0) > 0 || (sourceSummary?.slpisPersonalReferenceRecords || 0) > 0) && ((sourceSummary?.slpDptReferenceRecords || 0) === 0 || (sourceSummary?.slpisPersonalReferenceRecords || 0) === 0) && (
              <div className="rounded-lg bg-amber-50 border border-amber-200 p-4 text-sm font-medium text-amber-800">
                Partial reference sources loaded: SLP DPT {sourceSummary?.slpDptReferenceRecords || 0} records, SLPIS Personal Module {sourceSummary?.slpisPersonalReferenceRecords || 0} records. Accuracy is better when both sources are available.
              </div>
            )}
            {sourceSummary?.filesCheckedForMatchCompare?.length > 0 && (
              <details className="rounded-lg border border-[#D8E6E1] bg-white p-4">
                <summary className="cursor-pointer text-sm font-bold text-[#064E3B]">
                  Detection debug: {sourceSummary.totalUploadedIndexedFilesFound || 0} uploaded/indexed file(s), {sourceSummary.filesCheckedForMatchCompare.length} checked source sheet(s)
                </summary>
                <div className="slp-table-wrap mt-3 max-h-72">
                  <table className="slp-table min-w-[900px]">
                    <thead>
                      <tr>
                        {["File name", "Folder", "Classification", "Detected source type", "Accepted", "Reason"].map((header) => <th key={header}>{header}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {sourceSummary.filesCheckedForMatchCompare.map((item: any, index: number) => (
                        <tr key={`${item.fileName}-${item.sheetName}-${index}`}>
                          <td>{item.originalFileName || item.fileName}{item.sheetName ? ` / ${item.sheetName}` : ""}</td>
                          <td>{item.folder || "-"}</td>
                          <td>{item.classification || "-"}</td>
                          <td>{item.detectedSourceType || "-"}</td>
                          <td>{item.accepted ? "true" : "false"}</td>
                          <td>{item.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}
          </div>

          <div className="flex gap-3">
            <button
              onClick={() => setStep(1)}
              className="flex-1 px-6 py-3 border border-[#D8E6E1] text-[#047857] rounded-lg hover:bg-[#F0FDF4] font-medium transition-colors"
            >
              Back
            </button>
            <button
              onClick={runMatch}
              disabled={matching || ((sourceSummary?.slpDptReferenceRecords || 0) === 0 && (sourceSummary?.slpisPersonalReferenceRecords || 0) === 0)}
              className="flex-1 px-6 py-3 bg-[#10B981] text-white rounded-lg hover:bg-[#065F46] disabled:opacity-50 font-medium transition-colors"
            >
              {matching ? "Matching..." : "Run Deep Accuracy Match"}
            </button>
          </div>
        </div>
      )}

      {step === 3 && (
        <>
          {progress && (
            <div className="mb-8 bg-white rounded-xl border border-[#D8E6E1] p-6 shadow-sm">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between mb-4">
                <div>
                  <h3 className="text-lg font-bold text-[#064E3B]">Backend Match Progress</h3>
                  <p className="text-sm text-[#64748B]">Current phase: {progress.currentPhase}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button onClick={goBackInMatchFlow} className="px-4 py-2 rounded-lg border border-[#D8E6E1] text-[#047857] hover:bg-[#F0FDF4] font-medium">Back</button>
                  {terminalStatus && <button onClick={startNewBatch} className="px-4 py-2 rounded-lg bg-[#047857] text-white hover:bg-[#065F46] font-medium">New Batch</button>}
                  {(terminalStatus || results.length > 0) && <button onClick={clearCurrentBatch} className="px-4 py-2 rounded-lg border border-[#D8E6E1] text-[#64748B] hover:bg-[#F8FAFC] font-medium">Clear Current Batch</button>}
                  {(progress.status === "running" || progress.status === "queued") && (
                    <button onClick={cancelJob} className="px-4 py-2 rounded-lg border border-red-200 text-red-700 hover:bg-red-50 font-medium">Cancel</button>
                  )}
                </div>
              </div>
              <div className="h-3 rounded-full bg-[#D8E6E1] overflow-hidden mb-4">
                <div className="h-full bg-[#047857]" style={{ width: `${progress.percent || 0}%` }} />
              </div>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                <ResultCard label="Processed / Total" value={progress.processed || 0} icon={`${progress.total || 0}`} />
                <ResultCard label="Exact Match" value={progress.exactCount || 0} icon="95+" />
                <ResultCard label="Possible Duplicate" value={progress.possibleCount || 0} icon="85+" />
                <ResultCard label="Weak / Review" value={progress.weakCount || 0} icon="70+" />
                <ResultCard label="No Match" value={progress.noMatchCount || 0} icon="<70" />
              </div>
              <div className="mt-4 grid gap-3 md:grid-cols-4 text-sm text-[#64748B]">
                <div>Error count: <strong>{progress.errorCount || 0}</strong></div>
                <div>Elapsed: <strong>{Math.round((progress.elapsedMs || 0) / 1000)}s</strong></div>
                <div>Estimated remaining: <strong>{Math.round((progress.estimatedRemainingMs || 0) / 1000)}s</strong></div>
                <div>Status: <strong>{progress.status}</strong></div>
              </div>
              {estimatedLong && <div className="mt-4 rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm font-medium text-amber-800">This match may take longer than expected. Continue Deep Scan?</div>}
            </div>
          )}

          {results.length > 0 && (
            <div className="bg-white rounded-xl border border-[#D8E6E1] shadow-sm overflow-hidden">
              <div className="p-6 border-b border-[#D8E6E1] flex justify-between items-center">
                <h3 className="text-lg font-bold text-[#064E3B]">Detailed Results</h3>
                <div className="flex flex-wrap gap-2">
                  <button onClick={goBackInMatchFlow} className="px-4 py-2 border border-[#D8E6E1] text-[#047857] rounded-lg hover:bg-[#F0FDF4] font-medium">Back</button>
                  <button onClick={startNewBatch} className="px-4 py-2 bg-[#047857] text-white rounded-lg hover:bg-[#065F46] font-medium">New Batch</button>
                  <button onClick={clearCurrentBatch} className="px-4 py-2 border border-[#D8E6E1] text-[#64748B] rounded-lg hover:bg-[#F8FAFC] font-medium">Clear Current Batch</button>
                  <button onClick={() => downloadCsv()} className="flex items-center gap-2 px-4 py-2 border border-[#D8E6E1] text-[#047857] rounded-lg hover:bg-[#F0FDF4] font-medium"><Download size={18} /> Download CSV</button>
                  <button onClick={() => downloadExcel()} className="flex items-center gap-2 px-4 py-2 bg-[#047857] text-white rounded-lg hover:bg-[#065F46] font-medium"><Download size={18} /> Download Excel</button>
                </div>
              </div>
              <div className="slp-table-wrap rounded-none border-x-0 border-t-0 shadow-none">
                <table className="slp-table min-w-[2300px]">
                  <thead>
                    <tr>
                      {["Input Name", "Input Municipality", "Input Barangay", "Matched Name", "Source", "Score", "Category", "Match Reason", "Matched Municipality", "Matched Barangay", "SLP Participant ID", "Pantawid Status", "Household ID", "SLP Unique ID", "Fund Source", "Type of Participant", "Actions"].map((header) => (
                        <th key={header}>{header}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pagedResults.map((row) => (
                      <React.Fragment key={row.id || `${row.rowNumber}-${row.inputName}`}>
                      <tr>
                        <td className="font-medium text-[#0F172A]">{row.inputName || "-"}</td>
                        <td>{row.inputMunicipality || "-"}</td>
                        <td>{row.inputBarangay || "-"}</td>
                        <td>{row.matchedName || "-"}</td>
                        <td>{row.source || "-"}</td>
                        <td>{row.finalScore}</td>
                        <td>
                          <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-bold ${
                            row.category === "Exact Match" ? "bg-green-50 text-green-700" :
                            row.category === "Possible Duplicate" ? "bg-red-50 text-red-700" :
                            row.category?.includes("Weak") ? "bg-amber-50 text-amber-700" :
                            "bg-slate-50 text-slate-700"
                          }`}>
                            {row.category}
                          </span>
                        </td>
                        <td className="max-w-xs">
                          <div>{row.reason || "-"}</div>
                          <div className="mt-2 text-xs font-semibold text-[#0F172A]">{row.addressMatchStatus || addressMatchStatus(row)}</div>
                        </td>
                        <td>
                          <div>{row.municipality || "-"}</div>
                          {addressWarnings(row).includes("Municipality differs") && <div className="mt-1 text-xs font-bold text-red-700">Municipality differs</div>}
                        </td>
                        <td>
                          <div>{row.barangay || "-"}</div>
                          {addressWarnings(row).includes("Barangay differs") && <div className="mt-1 text-xs font-bold text-amber-700">Barangay differs</div>}
                        </td>
                        <td>{row.slpParticipantId || "-"}</td>
                        <td>{row.pantawidStatus || "-"}</td>
                        <td>{row.householdId || "-"}</td>
                        <td>{row.slpUniqueId || "-"}</td>
                        <td>{row.fundSource || "-"}</td>
                        <td>{row.typeOfParticipant || "-"}</td>
                        <td>
                          <div className="flex flex-col gap-2 min-w-40">
                            <button onClick={() => setExpanded(expanded === row.id ? null : row.id)} className="px-3 py-1 rounded-md border border-[#D8E6E1] text-[#047857] hover:bg-[#F0FDF4] text-xs font-medium">View Top Candidates</button>
                            <button onClick={() => saveFeedback(row, "correct")} className="px-3 py-1 rounded-md bg-[#047857] text-white hover:bg-[#065F46] text-xs font-medium">Correct Match</button>
                            <button onClick={() => saveFeedback(row, "wrong")} className="px-3 py-1 rounded-md border border-red-200 text-red-700 hover:bg-red-50 text-xs font-medium">Wrong Match</button>
                            <button onClick={() => saveFeedback(row, "not_sure")} className="px-3 py-1 rounded-md border border-amber-200 text-amber-700 hover:bg-amber-50 text-xs font-medium">Not Sure</button>
                            <button onClick={() => saveFeedback(row, "manual_link")} className="px-3 py-1 rounded-md border border-[#D8E6E1] text-[#064E3B] hover:bg-[#F0FDF4] text-xs font-medium">Manually Link Record</button>
                          </div>
                        </td>
                      </tr>
                      {expanded === row.id && (
                        <tr className="border-t border-[#D8E6E1] bg-[#F8FAFC]">
                          <td colSpan={17} className="p-4">
                            <div className="grid gap-3 md:grid-cols-3">
                              {(row.topCandidates || []).map((candidate: any, index: number) => (
                                <div key={`${row.id}-${index}`} className="rounded-lg border border-[#D8E6E1] bg-white p-3 text-sm">
                                  <div className="font-bold text-[#064E3B]">{candidate.candidateName || "-"}</div>
                                  <div className="text-[#64748B]">{candidate.source} · {candidate.score}%</div>
                                  <div className="text-[#64748B]">{candidate.id || candidate.slpParticipantId || candidate.slpUniqueId || "-"}</div>
                                  <div className="text-[#64748B]">{candidate.municipality || "-"} / {candidate.barangay || "-"}</div>
                                  {candidate.source === "SLPIS Personal Module" && (
                                    <div className="mt-2 space-y-1 text-[#64748B]">
                                      <div>Is Pantawid?: {candidate.isPantawid || "-"}</div>
                                      <div>Household ID: {candidate.householdId || "-"}</div>
                                      <div>SLP Participant ID: {candidate.slpParticipantId || "-"}</div>
                                    </div>
                                  )}
                                  {candidate.source === "SLP DPT" && (
                                    <div className="mt-2 space-y-1 text-[#64748B]">
                                      <div>Type of participants: {candidate.typeOfParticipant || "-"}</div>
                                      <div>Fund Source: {candidate.fundSource || "-"}</div>
                                      <div>SLP UNIQUE ID: {candidate.slpUniqueId || "-"}</div>
                                    </div>
                                  )}
                                  <div className="mt-2 text-[#0F172A]">{candidate.reason}</div>
                                </div>
                              ))}
                            </div>
                            <pre className="mt-3 max-h-48 overflow-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100">{JSON.stringify(row.scoreBreakdown || {}, null, 2)}</pre>
                          </td>
                        </tr>
                      )}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between border-t border-[#D8E6E1] p-4 text-sm">
                <span className="text-[#64748B]">Page {page} of {pageCount}</span>
                <div className="flex gap-2">
                  <button disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} className="rounded-lg border border-[#D8E6E1] px-3 py-2 disabled:opacity-50">Previous</button>
                  <button disabled={page >= pageCount} onClick={() => setPage((p) => Math.min(pageCount, p + 1))} className="rounded-lg border border-[#D8E6E1] px-3 py-2 disabled:opacity-50">Next</button>
                </div>
              </div>
            </div>
          )}

          {message && (
            <div className={`mt-4 rounded-lg px-4 py-3 text-sm ${
              message.includes("fail") || message.includes("error")
                ? "bg-red-50 text-red-800"
                : "bg-green-50 text-green-800"
            }`}>
              {message}
            </div>
          )}

          {(progress || results.length > 0) && (
            <div className="sticky bottom-0 z-20 mt-6 border border-[#D8E6E1] bg-white/95 p-3 shadow-lg backdrop-blur">
              <div className="flex flex-wrap items-center justify-end gap-2">
                <button onClick={goBackInMatchFlow} className="px-4 py-2 rounded-lg border border-[#D8E6E1] text-[#047857] hover:bg-[#F0FDF4] font-medium">
                  Back
                </button>
                {showNewBatchButton && (
                  <button onClick={startNewBatch} className="px-4 py-2 rounded-lg bg-[#047857] text-white hover:bg-[#065F46] font-medium">
                    New Batch
                  </button>
                )}
                {results.length > 0 && (
                  <button onClick={() => downloadExcel()} className="flex items-center gap-2 px-4 py-2 rounded-lg border border-[#D8E6E1] text-[#047857] hover:bg-[#F0FDF4] font-medium">
                    <Download size={18} /> Export
                  </button>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function StepIndicator({ step, currentStep, label }: { step: number; currentStep: number; label: string }) {
  const isActive = step <= currentStep;
  return (
    <div className="flex items-center gap-3">
      <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm ${
        isActive ? "bg-[#047857] text-white" : "bg-[#D8E6E1] text-[#64748B]"
      }`}>
        {step}
      </div>
      <span className={`text-sm font-medium ${isActive ? "text-[#047857]" : "text-[#64748B]"}`}>
        {label}
      </span>
    </div>
  );
}

function ResultCard({ label, value, icon }: { label: string; value: number | string; icon: string }) {
  return (
    <div className="bg-gradient-to-br from-[#F0FDF4] to-white rounded-lg border border-[#D8E6E1] p-4">
      <p className="text-3xl mb-2">{icon}</p>
      <p className="text-2xl font-bold text-[#064E3B] mb-1">{value}</p>
      <p className="text-xs text-[#64748B] font-medium">{label}</p>
    </div>
  );
}

type FaqRow = {
  id: string;
  normalized_key?: string;
  question_topic?: string;
  normalized_question?: string;
  original_question_sample?: string;
  category: string;
  ask_count: number;
  last_asked_at: string;
  created_at: string;
};

type ModelSettings = {
  provider: string;
  roles: Record<string, { model: string }>;
  baseUrl: string;
  enableImageDocumentVision: boolean;
  timeoutMs: number;
  enableVerificationForComplexOnly: boolean;
  loadedFrom?: string;
};

type ModelRoleStatus = {
  model: string;
  configuredModel?: string;
  selectedModel?: string;
  fallbackUsed?: boolean;
  installed: boolean;
  status?: string;
  responseTime?: number;
  error?: string;
};

type AuditLogRow = {
  id: string;
  created_at: string;
  user: string;
  action: string;
  feature: string;
  file: string;
  details: string;
};

function AdminPanel({
  profile,
  settings,
  onSettingsChange,
}: {
  profile: Profile | null;
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
}) {
  const [adminTab, setAdminTab] = useState<"users" | "faq" | "settings" | "models" | "audit">("users");
  const [users, setUsers] = useState<Profile[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [faqs, setFaqs] = useState<FaqRow[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogRow[]>([]);
  const [faqCategories, setFaqCategories] = useState<string[]>([]);
  const [faqSearch, setFaqSearch] = useState("");
  const [faqCategory, setFaqCategory] = useState("all");
  const [faqSort, setFaqSort] = useState("most");
  const [filter, setFilter] = useState("all");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [logoPreview, setLogoPreview] = useState(settings.app_logo_url || "");
  const [savingLogo, setSavingLogo] = useState(false);
  const [modelSettings, setModelSettings] = useState<ModelSettings>({
    provider: "GitHub Models",
    roles: {},
    baseUrl: "https://models.github.ai/inference",
    enableImageDocumentVision: true,
    timeoutMs: 90000,
    enableVerificationForComplexOnly: true,
  });
  const [githubModels, setGithubModels] = useState<string[]>([]);
  const [githubRoleStatus, setGithubRoleStatus] = useState<Record<string, ModelRoleStatus>>({});
  const [githubMessage, setGithubMessage] = useState("");
  const [testingGithubModels, setTestingGithubModels] = useState(false);
  const [passwordEdits, setPasswordEdits] = useState<Record<string, string>>({});
  const [newUser, setNewUser] = useState({
    email: "",
    password: "",
    fullName: "",
    role: "user",
    status: "approved",
  });

  const loadAdminData = async () => {
    if (!profile) return;

    setLoading(true);
    setMessage("");

    try {
      const [usersRes, statsRes] = await Promise.all([
        apiFetch(`/api/admin/users?adminId=${profile.id}&status=${filter}`, undefined, { endpointName: "Admin users" }),
        apiFetch(`/api/admin/stats?adminId=${profile.id}`, undefined, { endpointName: "Admin stats" })
      ]);
      const usersData = await readJsonResponse(usersRes);
      const statsData = await readJsonResponse(statsRes);

      if (!usersRes.ok) throw new Error(usersData.error || "Could not load users.");
      if (!statsRes.ok) throw new Error(statsData.error || "Could not load admin stats.");

      setUsers(usersData.users || []);
      setStats(statsData.stats);
    } catch (error: any) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAdminData();
  }, [profile?.id, filter]);

  useEffect(() => {
    setLogoPreview(settings.app_logo_url || "");
  }, [settings.app_logo_url]);

  const loadFaqs = async () => {
    if (!profile) return;

    setLoading(true);
    setMessage("");

    try {
      const params = new URLSearchParams({
        adminId: profile.id,
        search: faqSearch,
        category: faqCategory,
        sort: faqSort,
      });
      const res = await apiFetch(`/api/admin/faq-analytics?${params.toString()}`, undefined, { endpointName: "FAQ analytics" });
      const data = await readJsonResponse(res);

      if (!res.ok) throw new Error(data.error || "Could not load FAQ analytics.");

      setFaqs(data.items || data.faqs || []);
      setFaqCategories(data.categories || []);
    } catch (error: any) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (adminTab === "faq") loadFaqs();
  }, [adminTab, profile?.id, faqCategory, faqSort]);

  const loadAuditLogs = async () => {
    if (!profile) return;
    setLoading(true);
    setMessage("");
    try {
      const res = await apiFetch(`/api/admin/audit-logs?adminId=${encodeURIComponent(profile.id)}`, undefined, { endpointName: "Audit logs" });
      const data = await readJsonResponse(res);
      if (!res.ok) throw new Error(data.error || "Could not load audit logs.");
      setAuditLogs(data.logs || []);
    } catch (error: any) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (adminTab === "audit") loadAuditLogs();
  }, [adminTab, profile?.id]);

  const settingsFromModelResponse = (data: any): ModelSettings => ({
    provider: "GitHub Models",
    baseUrl: data.baseUrl || data.settings?.baseUrl || "https://models.github.ai/inference",
    timeoutMs: Number(data.timeoutMs || data.settings?.timeoutMs || 90000),
    enableImageDocumentVision: data.settings?.enableImageDocumentVision ?? true,
    enableVerificationForComplexOnly: data.settings?.enableVerificationForComplexOnly ?? true,
    loadedFrom: data.loadedFrom || data.settings?.loadedFrom || "fallback",
    roles: {
      router: { model: data.router || data.settings?.roles?.router?.model || "" },
      main: { model: data.main || data.settings?.roles?.main?.model || "" },
      dataAnalysis: { model: data.dataAnalysis || data.settings?.roles?.dataAnalysis?.model || "" },
      chartRecommendation: { model: data.chartRecommendation || data.settings?.roles?.chartRecommendation?.model || "" },
      verification: { model: data.verification || data.settings?.roles?.verification?.model || "" },
      vision: { model: data.vision || data.settings?.roles?.vision?.model || "" },
      fallback: { model: data.fallback || data.settings?.roles?.fallback?.model || "" },
    },
  });

  const loadModelSettings = async () => {
    if (!profile) return;

    try {
      const res = await apiFetch("/api/models/settings", undefined, { endpointName: "Model settings" });
      const data = await readJsonResponse(res);
      if (!res.ok) throw new Error(data.error || "Could not load GitHub Models settings.");
      setModelSettings(settingsFromModelResponse(data));
      setGithubMessage(`Model settings loaded from ${data.loadedFrom || data.settings?.loadedFrom || "fallback"}.`);
    } catch (error: any) {
      setGithubMessage(error.message);
    }
  };

  const loadGithubModels = async () => {
    if (!profile) return;

    try {
      const res = await apiFetch(`/api/models/catalog?adminId=${encodeURIComponent(profile.id)}`, undefined, { endpointName: "Model catalog" });
      const data = await readJsonResponse(res);
      if (!res.ok) throw new Error(data.error || "Could not list GitHub Models models.");
      setGithubModels((data.models || []).filter(Boolean));
      setGithubRoleStatus({});
      setGithubMessage("GitHub Models catalog loaded.");
    } catch (error: any) {
      setGithubMessage(error.message);
    }
  };

  const saveModelSettings = async () => {
    if (!profile) return;

    try {
      const res = await apiFetch("/api/admin/model-settings/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adminId: profile.id, settings: modelSettings }),
      });
      const data = await readJsonResponse(res);
      if (!res.ok) throw new Error(data.error || "Could not save GitHub Models settings.");
      setModelSettings(data.settings);
      setGithubMessage("GitHub Models settings saved.");
    } catch (error: any) {
      setGithubMessage(error.message);
    }
  };

  const testGithubModels = async () => {
    if (!profile) return;

    setTestingGithubModels(true);
    try {
      const res = await apiFetch("/api/admin/test-all-models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adminId: profile.id, settings: modelSettings }),
      });
      const data = await readJsonResponse(res);
      if (!res.ok) throw new Error(data.details || data.error || "GitHub Models test failed.");
      if (data.settings) setModelSettings(data.settings);
      setGithubRoleStatus(data.roleStatus || {});
      const savedMessage = data.saved ? " Working model IDs were saved to the database." : "";
      setGithubMessage(data.catalogError ? `Selected models tested. Catalog lookup failed: ${data.catalogError}${savedMessage}` : `Selected models tested.${savedMessage} Check role health below.`);
    } catch (error: any) {
      setGithubMessage(error.message);
    } finally {
      setTestingGithubModels(false);
    }
  };

  const clearChatMemory = async () => {
    if (!profile) return;
    try {
      const res = await apiFetch("/api/admin/memory/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adminId: profile.id, userId: profile.id }),
      });
      const data = await readJsonResponse(res);
      if (!res.ok) throw new Error(data.error || "Could not clear chat memory.");
      Object.keys(localStorage).forEach((key) => {
        if (/github|model|catalog|selected/i.test(key)) localStorage.removeItem(key);
      });
      setGithubModels([]);
      setGithubRoleStatus({});
      await loadModelSettings();
      setGithubMessage(`Memory cleared (${data.deleted || 0} item${data.deleted === 1 ? "" : "s"}), cached model selections removed, and settings reloaded.`);
    } catch (error: any) {
      setGithubMessage(error.message);
    }
  };

  useEffect(() => {
    if (adminTab === "models") {
      loadModelSettings();
    }
  }, [adminTab, profile?.id]);

  const updateUser = async (userId: string, payload: Record<string, string>) => {
    if (!profile) return;

    setMessage("");

    try {
      const res = await apiFetch("/api/admin/users", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adminId: profile.id, userId, ...payload })
      });
      const data = await readJsonResponse(res);

      if (!res.ok) throw new Error(data.error || "User update failed.");

      setMessage(payload.password ? "Password updated." : "User updated.");
      if (payload.password) {
        setPasswordEdits((current) => ({ ...current, [userId]: "" }));
      }
      loadAdminData();
    } catch (error: any) {
      setMessage(error.message);
    }
  };

  const createUser = async () => {
    if (!profile || !newUser.email.trim() || !newUser.password.trim()) return;

    setCreating(true);
    setMessage("");

    try {
      const res = await apiFetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adminId: profile.id, ...newUser }),
      });
      const data = await readJsonResponse(res);

      if (!res.ok) throw new Error(data.error || "User creation failed.");

      setMessage("User created.");
      setNewUser({ email: "", password: "", fullName: "", role: "user", status: "approved" });
      loadAdminData();
    } catch (error: any) {
      setMessage(error.message);
    } finally {
      setCreating(false);
    }
  };

  const deleteUser = async (user: Profile) => {
    if (!profile || !window.confirm(`Delete ${user.email}?`)) return;

    try {
      const res = await apiFetch(`/api/admin/users/${user.id}?adminId=${profile.id}`, {
        method: "DELETE"
      });
      const data = await readJsonResponse(res);

      if (!res.ok) throw new Error(data.error || "Delete failed.");

      setMessage("User deleted.");
      loadAdminData();
    } catch (error: any) {
      setMessage(error.message);
    }
  };

  const chooseLogo = async (file: File | null) => {
    if (!file) return;
    if (!/image\/(png|jpe?g|webp)/i.test(file.type)) {
      setMessage("Logo must be PNG, JPG, JPEG, or WEBP.");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setMessage("Logo file must be 2 MB or smaller.");
      return;
    }

    setLogoPreview(await readFileAsDataUrl(file));
    setMessage("");
  };

  const saveLogo = async (nextLogo = logoPreview) => {
    if (!profile) return;

    setSavingLogo(true);
    setMessage("");

    try {
      const res = await apiFetch("/api/admin/app-settings/logo", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adminId: profile.id, logoUrl: nextLogo }),
      });
      const data = await readJsonResponse(res);

      if (!res.ok) throw new Error(data.error || "Logo update failed.");

      onSettingsChange(data.settings || { app_logo_url: nextLogo });
      setLogoPreview(data.settings?.app_logo_url || "");
      setMessage(nextLogo ? "Logo saved." : "Default logo restored.");
    } catch (error: any) {
      setMessage(error.message);
    } finally {
      setSavingLogo(false);
    }
  };

  const updateModelRole = (role: string, model: string) => {
    setModelSettings((current) => ({
      ...current,
      roles: {
        ...current.roles,
        [role]: { model },
      },
    }));
  };

  const applySafeModelDefaults = () => {
    setModelSettings((current) => ({
      ...current,
      roles: {
        ...current.roles,
        router: { model: "openai/gpt-4.1-mini" },
        main: { model: "openai/gpt-4.1" },
        dataAnalysis: { model: "openai/gpt-4.1" },
        chartRecommendation: { model: "openai/gpt-4.1" },
        verification: { model: "openai/gpt-4.1-mini" },
        vision: { model: "openai/gpt-4o" },
        fallback: { model: "openai/gpt-4.1-mini" },
      },
      timeoutMs: 120000,
    }));
  };

  return (
    <div>
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-3xl font-bold text-[#064E3B] mb-2">Admin Panel</h2>
            <p className="text-[#64748B]">Manage users, system settings, and app configuration</p>
          </div>
          <button 
            onClick={adminTab === "faq" ? loadFaqs : adminTab === "audit" ? loadAuditLogs : loadAdminData} 
            className="flex items-center gap-2 px-4 py-2 bg-white border border-[#D8E6E1] text-[#047857] rounded-lg hover:bg-[#F0FDF4] font-medium transition-colors"
          >
            <RefreshCw size={18} />
            Refresh
          </button>
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="mb-8 flex gap-2 rounded-lg bg-white p-1 border border-[#D8E6E1] shadow-sm overflow-x-auto">
        {[
          ["users", "Users"],
          ["faq", "FAQ Analytics"],
          ["audit", "Audit Logs"],
          ["models", "Models"],
          ["settings", "Settings"],
        ].map(([value, label]) => (
          <button
            key={value}
            onClick={() => setAdminTab(value as "users" | "faq" | "settings" | "models" | "audit")}
            className={`px-4 py-3 rounded-lg text-sm font-semibold whitespace-nowrap transition-all ${
              adminTab === value
                ? "bg-[#10B981] text-white shadow-md"
                : "text-[#64748B] hover:text-[#047857]"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {adminTab === "users" && stats && (
        <div className="mb-8 grid grid-cols-2 md:grid-cols-5 gap-4">
          <StatCard label="Total Users" value={stats.totalUsers} />
          <StatCard label="Approved" value={stats.approvedUsers} />
          <StatCard label="Pending" value={stats.pendingUsers} />
          <StatCard label="Admins" value={stats.adminUsers} />
          <StatCard label="Documents" value={stats.totalDocuments} />
        </div>
      )}

      {adminTab === "users" && (
        <>
      <div className="bg-white rounded-xl border border-[#D8E6E1] p-6 shadow-sm mb-6">
        <div className="flex items-center gap-2 mb-4 text-lg font-bold text-[#064E3B]">
          <UserPlus size={20} />
          Add New User
        </div>
        <div className="grid grid-cols-1 md:grid-cols-6 gap-3">
          <input
            className="md:col-span-2 border border-[#D8E6E1] rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-[#10B981]"
            placeholder="Email"
            value={newUser.email}
            onChange={(event) => setNewUser((current) => ({ ...current, email: event.target.value }))}
          />
          <input
            className="md:col-span-1 border border-[#D8E6E1] rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-[#10B981]"
            placeholder="Password"
            type="password"
            value={newUser.password}
            onChange={(event) => setNewUser((current) => ({ ...current, password: event.target.value }))}
          />
          <input
            className="md:col-span-1 border border-[#D8E6E1] rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-[#10B981]"
            placeholder="Full name"
            value={newUser.fullName}
            onChange={(event) => setNewUser((current) => ({ ...current, fullName: event.target.value }))}
          />
          <select
            className="md:col-span-1 border border-[#D8E6E1] rounded-lg px-4 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-[#10B981]"
            value={newUser.role}
            onChange={(event) => setNewUser((current) => ({ ...current, role: event.target.value }))}
          >
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </select>
          <button
            onClick={createUser}
            disabled={creating || !newUser.email.trim() || !newUser.password.trim()}
            className="md:col-span-1 bg-[#047857] text-white rounded-lg disabled:opacity-50 hover:bg-[#065F46] font-medium transition-colors"
          >
            {creating ? "Adding..." : "Add User"}
          </button>
        </div>
      </div>

      <div className="mb-4">
        <select 
          value={filter} 
          onChange={(event) => setFilter(event.target.value)} 
          className="border border-[#D8E6E1] px-4 py-2 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-[#10B981]"
        >
          <option value="all">All users</option>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
        </select>
      </div>

      <div className="bg-white rounded-xl border border-[#D8E6E1] shadow-sm overflow-hidden">
        <table className="w-full">
          <thead className="bg-[#F0FDF4] border-b border-[#D8E6E1]">
            <tr>
              <th className="p-4 text-left text-sm font-bold text-[#064E3B]">Email</th>
              <th className="p-4 text-left text-sm font-bold text-[#064E3B]">Name</th>
              <th className="p-4 text-left text-sm font-bold text-[#064E3B]">Status</th>
              <th className="p-4 text-left text-sm font-bold text-[#064E3B]">Role</th>
              <th className="p-4 text-left text-sm font-bold text-[#064E3B]">Password</th>
              <th className="p-4 text-left text-sm font-bold text-[#064E3B]">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id} className="border-t border-[#D8E6E1] hover:bg-[#F0FDF4] transition-colors">
                <td className="p-4 font-medium text-[#0F172A]">{user.email}</td>
                <td className="p-4 text-[#64748B]">{user.full_name || "-"}</td>
                <td className="p-4">
                  <span className={`inline-flex px-2 py-1 rounded-full text-xs font-bold ${
                    user.status === "approved" ? "bg-green-50 text-green-700" :
                    user.status === "pending" ? "bg-amber-50 text-amber-700" :
                    "bg-red-50 text-red-700"
                  }`}>
                    {user.status}
                  </span>
                </td>
                <td className="p-4">
                  <select
                    value={user.role}
                    onChange={(event) => updateUser(user.id, { role: event.target.value })}
                    className="border border-[#D8E6E1] px-2 py-1 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-[#10B981]"
                    disabled={user.id === profile?.id}
                  >
                    <option value="user">User</option>
                    <option value="admin">Admin</option>
                  </select>
                </td>
                <td className="p-4">
                  <div className="flex gap-2">
                    <input
                      className="w-32 rounded-lg border border-[#D8E6E1] px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-[#10B981]"
                      placeholder="New password"
                      type="password"
                      value={passwordEdits[user.id] || ""}
                      onChange={(event) => setPasswordEdits((current) => ({ ...current, [user.id]: event.target.value }))}
                    />
                    <button
                      onClick={() => updateUser(user.id, { password: passwordEdits[user.id] || "" })}
                      disabled={!(passwordEdits[user.id] || "").trim()}
                      className="rounded-lg border border-[#D8E6E1] px-2 py-1 text-xs text-[#047857] hover:bg-[#F0FDF4] disabled:opacity-50 font-medium transition-colors"
                    >
                      Save
                    </button>
                  </div>
                </td>
                <td className="p-4 flex gap-2">
                  <button
                    onClick={() => updateUser(user.id, { action: "approve" })}
                    className="text-green-600 hover:text-green-800 transition-colors"
                    title="Approve user"
                  >
                    <UserCheck size={20} />
                  </button>
                  <button
                    onClick={() => updateUser(user.id, { action: "reject" })}
                    className="text-amber-600 hover:text-amber-800 transition-colors"
                    title="Reject user"
                  >
                    <UserX size={20} />
                  </button>
                  <button
                    onClick={() => deleteUser(user)}
                    className="text-[#DC2626] hover:text-red-700 disabled:opacity-50 transition-colors"
                    disabled={user.id === profile?.id}
                    title="Delete user"
                  >
                    <Trash2 size={20} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
        </>
      )}

      {adminTab === "faq" && (
        <div className="bg-white rounded-xl border border-[#D8E6E1] p-6 shadow-sm">
          <div className="mb-6">
            <h3 className="text-lg font-bold text-[#064E3B] mb-2">FAQ Analytics</h3>
            <p className="text-sm text-[#64748B]">Similar questions are grouped by normalized wording and category.</p>
          </div>
          <div className="flex flex-col lg:flex-row gap-4 mb-6">
            <div className="flex items-center gap-2 rounded-lg border border-[#D8E6E1] px-4 py-2 flex-1">
              <Search size={20} className="text-[#64748B]" />
              <input
                className="w-full outline-none"
                placeholder="Search questions..."
                value={faqSearch}
                onChange={(event) => setFaqSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") loadFaqs();
                }}
              />
            </div>
            <select 
              value={faqCategory} 
              onChange={(event) => setFaqCategory(event.target.value)} 
              className="rounded-lg border border-[#D8E6E1] bg-white px-4 py-2 focus:outline-none focus:ring-2 focus:ring-[#10B981]"
            >
              <option value="all">All categories</option>
              {faqCategories.map((category) => (
                <option key={category} value={category}>{category}</option>
              ))}
            </select>
            <select 
              value={faqSort} 
              onChange={(event) => setFaqSort(event.target.value)} 
              className="rounded-lg border border-[#D8E6E1] bg-white px-4 py-2 focus:outline-none focus:ring-2 focus:ring-[#10B981]"
            >
              <option value="most">Most asked</option>
              <option value="newest">Newest</option>
              <option value="category">Category</option>
            </select>
            <button 
              onClick={loadFaqs} 
              className="rounded-lg bg-[#047857] text-white px-4 py-2 hover:bg-[#065F46] font-medium transition-colors"
            >
              Apply
            </button>
          </div>

          <div className="overflow-x-auto rounded-lg border border-[#D8E6E1]">
            <table className="w-full min-w-full">
              <thead className="bg-[#F0FDF4] border-b border-[#D8E6E1]">
                <tr>
                  <th className="p-4 text-left text-sm font-bold text-[#064E3B]">Question</th>
                  <th className="p-4 text-left text-sm font-bold text-[#064E3B]">Asked</th>
                  <th className="p-4 text-left text-sm font-bold text-[#064E3B]">Last Asked</th>
                  <th className="p-4 text-left text-sm font-bold text-[#064E3B]">Category</th>
                </tr>
              </thead>
              <tbody>
                {faqs.map((faq) => (
                  <tr key={faq.id} className="border-t border-[#D8E6E1] hover:bg-[#F0FDF4] transition-colors">
                    <td className="p-4 font-medium text-[#0F172A]">{faq.question_topic || faq.original_question_sample || "-"}</td>
                    <td className="p-4 text-[#64748B]">{faq.ask_count}</td>
                    <td className="p-4 text-sm text-[#64748B]">{faq.last_asked_at ? new Date(faq.last_asked_at).toLocaleString() : "-"}</td>
                    <td className="p-4 text-sm text-[#64748B]">{faq.category}</td>
                  </tr>
                ))}
                {!faqs.length && (
                  <tr>
                    <td className="p-8 text-sm text-center text-[#64748B]" colSpan={4}>No FAQ analytics yet. Ask the assistant a few questions to populate this table.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {adminTab === "audit" && (
        <div className="bg-white rounded-xl border border-[#D8E6E1] p-6 shadow-sm">
          <div className="mb-6">
            <h3 className="text-lg font-bold text-[#064E3B] mb-2">Audit Logs</h3>
            <p className="text-sm text-[#64748B]">Tracks uploads, deletes, questions, reports, and source usage.</p>
          </div>
          <div className="overflow-x-auto rounded-lg border border-[#D8E6E1]">
            <table className="w-full min-w-full text-sm">
              <thead className="bg-[#F0FDF4] border-b border-[#D8E6E1]">
                <tr>
                  <th className="p-4 text-left text-sm font-bold text-[#064E3B]">Date/Time</th>
                  <th className="p-4 text-left text-sm font-bold text-[#064E3B]">User</th>
                  <th className="p-4 text-left text-sm font-bold text-[#064E3B]">Action</th>
                  <th className="p-4 text-left text-sm font-bold text-[#064E3B]">File/Feature</th>
                  <th className="p-4 text-left text-sm font-bold text-[#064E3B]">Details</th>
                </tr>
              </thead>
              <tbody>
                {auditLogs.map((log) => (
                  <tr key={log.id} className="border-t border-[#D8E6E1] hover:bg-[#F0FDF4] transition-colors">
                    <td className="p-4 whitespace-nowrap text-[#64748B]">{new Date(log.created_at).toLocaleString()}</td>
                    <td className="p-4 text-[#0F172A]">{log.user}</td>
                    <td className="p-4 font-medium text-[#0F172A]">{log.action}</td>
                    <td className="p-4 text-[#64748B]">{log.file || log.feature}</td>
                    <td className="p-4 max-w-xl truncate text-[#64748B]" title={log.details}>{log.details}</td>
                  </tr>
                ))}
                {!auditLogs.length && (
                  <tr>
                    <td className="p-8 text-sm text-center text-[#64748B]" colSpan={5}>No audit logs yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {adminTab === "settings" && (
        <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
          <div className="bg-white rounded-xl border border-[#D8E6E1] p-6 shadow-sm h-fit">
            <div className="flex items-center gap-2 mb-4 font-bold text-[#064E3B]">
              <ImageIcon size={20} />
              Logo Preview
            </div>
            <div className="flex h-48 items-center justify-center rounded-lg border-2 border-dashed border-[#D8E6E1] bg-[#F0FDF4]">
              <AppLogo logoUrl={logoPreview} />
            </div>
            <p className="mt-4 text-sm text-[#64748B]">The selected logo appears on login, sidebar, and header.</p>
          </div>

          <div className="bg-white rounded-xl border border-[#D8E6E1] p-6 shadow-sm">
            <h3 className="text-lg font-bold text-[#064E3B] mb-4">App Logo Management</h3>
            <p className="text-sm text-[#64748B] mb-4">Upload PNG, JPG, JPEG, or WEBP images up to 2 MB.</p>
             <div className="space-y-4">
             <input
               type="file"
               accept="image/png,image/jpeg,image/jpg,image/webp"
               onChange={(event) => chooseLogo(event.target.files?.[0] || null)}
               className="mb-4 block w-full rounded-lg border border-[#D8E6E1] px-4 py-3 focus:outline-none focus:ring-2 focus:ring-[#10B981]"
             />
             <div className="flex flex-wrap gap-2">
               <button
                 onClick={() => saveLogo()}
                 disabled={savingLogo}
                 className="inline-flex items-center gap-2 rounded-lg bg-[#047857] text-white px-4 py-2 font-semibold hover:bg-[#065F46] disabled:opacity-50 transition-colors"
               >
                 <Save size={18} />
                 {savingLogo ? "Saving..." : "Save Logo"}
               </button>
               <button
                 onClick={() => setLogoPreview(settings.app_logo_url || "")}
                 className="inline-flex items-center gap-2 rounded-lg border border-[#D8E6E1] bg-white text-[#047857] px-4 py-2 font-semibold hover:bg-[#F0FDF4] transition-colors"
               >
                 <RotateCcw size={18} />
                 Reset Preview
               </button>
               <button
                 onClick={() => saveLogo("")}
                 disabled={savingLogo}
                 className="inline-flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 text-[#DC2626] px-4 py-2 font-semibold hover:bg-red-100 disabled:opacity-50 transition-colors"
               >
                 <Trash2 size={16} />
                 Restore Default
               </button>
             </div>
            </div>
           </div>
         </div>
       )}

      {adminTab === "models" && (
        <div className="bg-white rounded-xl border border-[#D8E6E1] p-6 shadow-sm">
          <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h3 className="text-lg font-bold text-[#064E3B]">GitHub Models Settings</h3>
              <p className="text-sm text-[#64748B]">Configure smart routing for analysis and verification using GitHub Models.</p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={testGithubModels}
                disabled={testingGithubModels}
                className="rounded-lg bg-blue-600 text-white px-4 py-2 hover:bg-blue-700 disabled:opacity-50 font-medium transition-colors"
              >
                {testingGithubModels ? "Testing..." : "Test selected models"}
              </button>
              <button
                onClick={loadGithubModels}
                className="rounded-lg bg-[#047857] text-white px-4 py-2 hover:bg-[#065F46] font-medium transition-colors"
              >
                Load Models
              </button>
              <button
                onClick={saveModelSettings}
                className="rounded-lg border border-[#D8E6E1] bg-white px-4 py-2 font-medium text-[#047857] transition-colors hover:bg-[#F0FDF4]"
              >
                Save Settings
              </button>
              <button
                onClick={applySafeModelDefaults}
                className="rounded-lg border border-[#D8E6E1] bg-white px-4 py-2 font-medium text-[#047857] transition-colors hover:bg-[#F0FDF4]"
              >
                Safe Defaults
              </button>
              <button
                onClick={clearChatMemory}
                className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 font-medium text-red-700 transition-colors hover:bg-red-100"
              >
                Clear Memory
              </button>
            </div>
          </div>

          {githubModels.length > 0 && (
            <div className="mb-6 p-4 rounded-lg bg-green-50 border border-green-200">
              <p className="text-sm text-green-800"><strong>GitHub Models catalog:</strong> {githubModels.join(", ")}</p>
            </div>
          )}

          {githubMessage && (
            <div className={`mt-4 rounded-lg px-4 py-3 text-sm ${
              githubMessage.includes("success") || githubMessage.includes("connected") || githubMessage.includes("loaded") || githubMessage.includes("tested") || githubMessage.includes("saved")
                ? "bg-green-50 text-green-800"
                : "bg-red-50 text-red-800"
            }`}>
              {githubMessage}
            </div>
          )}

          <label className="mb-4 flex items-center gap-2 text-sm font-medium text-slate-700">
            <input
              type="checkbox"
              checked={modelSettings.enableVerificationForComplexOnly}
              onChange={(event) => setModelSettings((current) => ({ ...current, enableVerificationForComplexOnly: event.target.checked }))}
            />
            Use verification only for complex/high-risk questions
          </label>
          <label className="mb-4 flex items-center gap-2 text-sm font-medium text-slate-700">
            <input
              type="checkbox"
              checked={modelSettings.enableImageDocumentVision}
              onChange={(event) => setModelSettings((current) => ({ ...current, enableImageDocumentVision: event.target.checked }))}
            />
            Enable image/document vision
          </label>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <label className="text-sm font-medium text-slate-700">
              GitHub Models base URL
              <input
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
                value={modelSettings.baseUrl || ""}
                onChange={(event) => setModelSettings((current) => ({ ...current, baseUrl: event.target.value }))}
              />
            </label>
            {Object.entries(modelSettings.roles || {}).map(([role, config]) => (
              <label key={role} className="text-sm font-medium text-slate-700">
                {role}
                <input
                  list="github-model-catalog"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
                  value={config.model || ""}
                  onChange={(event) => updateModelRole(role, event.target.value)}
                />
              </label>
            ))}
            <datalist id="github-model-catalog">
              {githubModels.map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
            <label className="text-sm font-medium text-slate-700">
              Timeout ms
              <input
                type="number"
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
                value={modelSettings.timeoutMs}
                onChange={(event) => setModelSettings((current) => ({ ...current, timeoutMs: Number(event.target.value) }))}
              />
            </label>
          </div>

          <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
            <p className="mb-2 text-sm font-semibold text-slate-700">Diagnostics</p>
            <div className="grid gap-2 text-sm text-slate-700 md:grid-cols-2 xl:grid-cols-3">
              <div>Loaded from: <strong>{modelSettings.loadedFrom || "fallback"}</strong></div>
              <div>Effective router model: <strong>{modelSettings.roles?.router?.model || "-"}</strong></div>
              <div>Effective main model: <strong>{modelSettings.roles?.main?.model || "-"}</strong></div>
              <div>Effective dataAnalysis model: <strong>{modelSettings.roles?.dataAnalysis?.model || "-"}</strong></div>
              <div>Effective chartRecommendation model: <strong>{modelSettings.roles?.chartRecommendation?.model || "-"}</strong></div>
              <div>Effective verification model: <strong>{modelSettings.roles?.verification?.model || "-"}</strong></div>
              <div>Effective vision model: <strong>{modelSettings.roles?.vision?.model || "-"}</strong></div>
              <div>Effective fallback model: <strong>{modelSettings.roles?.fallback?.model || "-"}</strong></div>
            </div>
          </div>

          {githubModels.length > 0 && (
            <div className="mt-4 rounded-lg bg-slate-50 p-3">
              <p className="mb-2 text-sm font-semibold text-slate-700">Catalog models</p>
              <div className="flex flex-wrap gap-2">
                {githubModels.map((model) => (
                  <span key={model} className="rounded-md bg-white px-2 py-1 text-xs text-slate-700 shadow-sm">{model}</span>
                ))}
              </div>
            </div>
          )}

          {Object.keys(githubRoleStatus).length > 0 && (
            <div className="mt-4 rounded-lg border border-slate-200 bg-white p-3">
              <p className="mb-2 text-sm font-semibold text-slate-700">Role health</p>
              <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {Object.entries(githubRoleStatus).map(([role, status]) => (
                  <div key={role} className="rounded-lg bg-slate-50 px-3 py-2 text-sm">
                    <div className="font-semibold capitalize text-slate-800">{role}</div>
                    <div className="truncate text-slate-600">{status.selectedModel || status.model}</div>
                    {status.fallbackUsed && (
                      <div className="truncate text-xs text-amber-700">Fallback from {status.configuredModel}</div>
                    )}
                    <div className={status.installed ? "text-emerald-700" : "text-red-700"}>
                      {status.status === "Rate limited"
                        ? "Rate limited"
                        : status.installed
                          ? `Reachable${status.responseTime ? ` in ${status.responseTime} ms` : ""}`
                          : (status.status || "Missing or unavailable")}
                    </div>
                    {!status.installed && status.error && <div className="mt-1 line-clamp-2 text-xs text-red-700">{status.error}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {githubMessage && <p className="mt-3 text-sm text-slate-700">{githubMessage}</p>}
        </div>
      )}

      {loading && <div className="mt-4 text-sm text-[#047857] font-medium">Loading admin data...</div>}
      {message && (
        <div className={`mt-4 rounded-lg px-4 py-3 text-sm ${
          message.includes("success") || message.includes("complete") || message.includes("saved") || message.includes("updated") || message.includes("deleted") || message.includes("created")
            ? "bg-green-50 text-green-800 border border-green-200"
            : "bg-red-50 text-red-800 border border-red-200"
        }`}>
          {message}
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-white rounded-xl p-6 border border-[#D8E6E1] shadow-sm hover:shadow-md transition-shadow">
      <p className="text-sm font-medium text-[#64748B] mb-1">{label}</p>
      <p className="text-3xl font-bold text-[#064E3B]">{value}</p>
    </div>
  );
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
