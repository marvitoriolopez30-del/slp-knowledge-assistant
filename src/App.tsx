import React, { useState, useEffect, useRef } from 'react';
import { supabase, Profile, Document, FOLDERS, UserStatus, UserRole } from './supabase';
import { 
  MessageSquare, 
  FileText, 
  Users, 
  Settings, 
  LogOut, 
  Send, 
  Plus, 
  Trash2, 
  Download, 
  Search,
  CheckCircle,
  XCircle,
  Clock,
  Menu,
  X,
  ChevronRight,
  BarChart3,
  FileSearch,
  Edit2
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell
} from 'recharts';
import ReactMarkdown from 'react-markdown';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const handleUploadError = (err: any) => {
  console.error('Upload error:', err);
  let message = err.message || 'An unknown error occurred.';
  
  if (message.includes('Bucket not found')) {
    message = 'STORAGE ERROR: The "knowledge" bucket is missing in your Supabase project. \n\nFIX: \n1. Go to your Supabase Dashboard -> Storage.\n2. Click "New Bucket".\n3. Name it exactly "knowledge".\n4. Set it to "Public" (so users can view documents).\n5. Click "Save".';
  }
  
  alert(message);
};

// --- Components ---

const SidebarItem = ({ icon: Icon, label, active, onClick, badge }: any) => (
  <button
    onClick={onClick}
    className={cn(
      "w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all duration-200 group",
      active 
        ? "bg-emerald-600 text-white shadow-lg shadow-emerald-200" 
        : "text-slate-600 hover:bg-emerald-50 hover:text-emerald-700"
    )}
  >
    <Icon size={20} className={cn(active ? "text-white" : "text-slate-400 group-hover:text-emerald-600")} />
    <span className="font-medium">{label}</span>
    {badge && (
      <span className="ml-auto bg-emerald-100 text-emerald-700 text-xs px-2 py-0.5 rounded-full font-bold">
        {badge}
      </span>
    )}
  </button>
);

const Card = ({ children, className }: any) => (
  <div className={cn("bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden", className)}>
    {children}
  </div>
);

const HealthCard = ({ title, status, description, fix }: any) => (
  <div className={cn(
    "p-4 rounded-xl border transition-all",
    status ? "bg-emerald-50/50 border-emerald-100" : "bg-red-50 border-red-100"
  )}>
    <div className="flex items-center justify-between mb-2">
      <h4 className="font-bold text-slate-800">{title}</h4>
      {status ? (
        <CheckCircle className="text-emerald-500" size={18} />
      ) : (
        <XCircle className="text-red-500" size={18} />
      )}
    </div>
    <p className="text-xs text-slate-500 mb-3">{description}</p>
    {!status && (
      <div className="bg-white/50 p-2 rounded-lg border border-red-100">
        <p className="text-[10px] font-bold text-red-800 uppercase mb-1">How to fix:</p>
        <code className="text-[10px] text-slate-700 break-all">{fix}</code>
      </div>
    )}
  </div>
);

// --- Main App ---

export default function App() {
  const [user, setUser] = useState<any>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'chat' | 'docs' | 'beneficiaries' | 'admin'>('chat');
  const [isSidebarOpen, setIsSidebarOpen] = useState(window.innerWidth > 1024);
  const [pendingUsersCount, setPendingUsersCount] = useState(0);

  // Responsive Sidebar
  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth < 1024) setIsSidebarOpen(false);
      else setIsSidebarOpen(true);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Auth State
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      if (session?.user) fetchProfile(session.user);
      else setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      if (session?.user) fetchProfile(session.user);
      else {
        setProfile(null);
        setLoading(false);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const fetchProfile = async (authUser: any) => {
    let { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', authUser.id)
      .single();
    
    // Auto-upgrade Master Admin if needed
    const isMasterAdmin = authUser.email === 'marvitoriolopez30@gmail.com';
    
    if (data && isMasterAdmin && (data.role !== 'admin' || data.status !== 'approved')) {
      const { data: updatedData, error: updateError } = await supabase
        .from('profiles')
        .update({ role: 'admin', status: 'approved' })
        .eq('id', authUser.id)
        .select()
        .single();
      
      if (!updateError) data = updatedData;
    }

    // Fallback for Master Admin if profile fetch failed or is missing
    if (!data && isMasterAdmin) {
      data = {
        id: authUser.id,
        email: authUser.email,
        role: 'admin',
        status: 'approved',
        full_name: 'Master Admin',
        created_at: new Date().toISOString()
      } as Profile;
    }

    if (error && error.code !== 'PGRST116' && !isMasterAdmin) {
      console.error('Error fetching profile:', error);
    } else {
      setProfile(data);
    }
    setLoading(false);
  };

  // Fetch pending users count for admin badge
  useEffect(() => {
    if (profile?.role === 'admin' || user?.email === 'marvitoriolopez30@gmail.com') {
      const fetchPendingCount = async () => {
        const { count } = await supabase
          .from('profiles')
          .select('*', { count: 'exact', head: true })
          .eq('status', 'pending');
        setPendingUsersCount(count || 0);
      };
      
      fetchPendingCount();

      const channel = supabase
        .channel('pending-users-count')
        .on('postgres_changes', { 
          event: '*', 
          schema: 'public', 
          table: 'profiles' 
        }, () => {
          fetchPendingCount();
        })
        .subscribe();

      return () => {
        supabase.removeChannel(channel);
      };
    }
  }, [profile, user]);

  const handleSignOut = () => supabase.auth.signOut();

  if (loading) {
    return (
      <div className="min-h-screen bg-emerald-50 flex items-center justify-center">
        <div className="text-center">
          <motion.div 
            animate={{ rotate: 360 }}
            transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
            className="w-12 h-12 border-4 border-emerald-600 border-t-transparent rounded-full mx-auto mb-4"
          />
          <p className="text-emerald-800 font-bold animate-pulse">Initializing SLP Assistant...</p>
        </div>
      </div>
    );
  }

  if (!user) return <AuthPage />;

  // If user is logged in but profile is still null, it might be a race condition during registration
  // or a missing profile. We show a loading state while we wait for the profile to appear.
  if (!profile) {
    return (
      <div className="min-h-screen bg-emerald-50 flex items-center justify-center p-6">
        <div className="text-center max-w-md">
          <motion.div 
            animate={{ rotate: 360 }}
            transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
            className="w-12 h-12 border-4 border-emerald-600 border-t-transparent rounded-full mx-auto mb-4"
          />
          <h2 className="text-xl font-bold text-slate-800">Finalizing Account...</h2>
          <p className="text-slate-500 mt-2">We're setting up your workspace. This usually takes just a second.</p>
          <button 
            onClick={handleSignOut}
            className="mt-6 text-sm font-bold text-emerald-600 hover:text-emerald-700"
          >
            Cancel and Sign Out
          </button>
        </div>
      </div>
    );
  }

  if (profile.status === 'pending') return <PendingPage onSignOut={handleSignOut} />;
  if (profile.status === 'rejected') return <RejectedPage onSignOut={handleSignOut} />;
  
  // Only approved users can access the main app
  if (profile.status !== 'approved') {
    return <RejectedPage onSignOut={handleSignOut} />;
  }

  return (
    <div className="min-h-screen bg-slate-50 flex overflow-hidden">
      {/* Mobile Overlay */}
      <AnimatePresence>
        {isSidebarOpen && window.innerWidth < 1024 && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setIsSidebarOpen(false)}
            className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-40 lg:hidden"
          />
        )}
      </AnimatePresence>

      {/* Sidebar */}
      <AnimatePresence mode="wait">
        {isSidebarOpen && (
          <motion.aside
            initial={{ x: -280 }}
            animate={{ x: 0 }}
            exit={{ x: -280 }}
            transition={{ type: "spring", damping: 25, stiffness: 200 }}
            className="fixed inset-y-0 left-0 w-72 bg-white border-r border-slate-200 z-50 flex flex-col shadow-2xl lg:shadow-none"
          >
            <div className="p-6 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-emerald-600 rounded-xl flex items-center justify-center text-white shadow-lg shadow-emerald-200">
                  <BarChart3 size={24} />
                </div>
                <div>
                  <h1 className="font-bold text-slate-800 leading-tight">SLP Assistant</h1>
                  <p className="text-xs text-slate-500 font-medium uppercase tracking-wider">Knowledge Base</p>
                </div>
              </div>
              <button 
                onClick={() => setIsSidebarOpen(false)}
                className="lg:hidden p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg"
              >
                <X size={20} />
              </button>
            </div>

            <nav className="flex-1 px-4 space-y-2 mt-4 overflow-y-auto">
              <SidebarItem 
                icon={MessageSquare} 
                label="AI Chatbot" 
                active={activeTab === 'chat'} 
                onClick={() => { setActiveTab('chat'); if(window.innerWidth < 1024) setIsSidebarOpen(false); }} 
              />
              <SidebarItem 
                icon={FileText} 
                label="Documents" 
                active={activeTab === 'docs'} 
                onClick={() => { setActiveTab('docs'); if(window.innerWidth < 1024) setIsSidebarOpen(false); }} 
              />
              <SidebarItem 
                icon={FileSearch} 
                label="Name Matching" 
                active={activeTab === 'beneficiaries'} 
                onClick={() => { setActiveTab('beneficiaries'); if(window.innerWidth < 1024) setIsSidebarOpen(false); }} 
              />
              {(profile?.role === 'admin' || user?.email === 'marvitoriolopez30@gmail.com') && (
                <SidebarItem 
                  icon={Settings} 
                  label="Admin Panel" 
                  active={activeTab === 'admin'} 
                  onClick={() => { setActiveTab('admin'); if(window.innerWidth < 1024) setIsSidebarOpen(false); }} 
                  badge={pendingUsersCount > 0 ? pendingUsersCount : null}
                />
              )}
            </nav>

            <div className="p-4 border-t border-slate-100">
              <div className="bg-slate-50 rounded-xl p-4 mb-4">
                <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-1">Logged in as</p>
                <p className="text-sm font-semibold text-slate-700 truncate">{user.email}</p>
                <p className={cn(
                  "text-[10px] font-bold px-2 py-0.5 rounded-full inline-block mt-2",
                  (profile?.role === 'admin' || user?.email === 'marvitoriolopez30@gmail.com') ? "bg-purple-100 text-purple-700" : "bg-emerald-100 text-emerald-700"
                )}>
                  {(profile?.role || (user?.email === 'marvitoriolopez30@gmail.com' ? 'admin' : 'user')).toUpperCase()}
                </p>
              </div>
              <button 
                onClick={handleSignOut}
                className="w-full flex items-center gap-3 px-4 py-3 text-slate-600 hover:bg-red-50 hover:text-red-600 rounded-lg transition-colors group"
              >
                <LogOut size={20} className="group-hover:text-red-600" />
                <span className="font-medium">Sign Out</span>
              </button>
            </div>
          </motion.aside>
        )}
      </AnimatePresence>

      {/* Main Content */}
      <main className={cn(
        "flex-1 flex flex-col transition-all duration-300 min-w-0 h-screen",
        isSidebarOpen ? "lg:ml-72" : "ml-0"
      )}>
        <header className="h-16 bg-white border-b border-slate-200 flex items-center px-4 lg:px-6 justify-between sticky top-0 z-40 shrink-0">
          <div className="flex items-center gap-4">
            <button 
              onClick={() => setIsSidebarOpen(!isSidebarOpen)}
              className="p-2 hover:bg-slate-100 rounded-lg text-slate-500"
            >
              <Menu size={20} />
            </button>
            <div className="lg:hidden flex items-center gap-2">
              <div className="w-8 h-8 bg-emerald-600 rounded-lg flex items-center justify-center text-white">
                <BarChart3 size={18} />
              </div>
              <span className="font-bold text-slate-800 text-sm">SLP Assistant</span>
            </div>
          </div>
          
          <div className="flex items-center gap-4">
             <div className="hidden sm:block text-right">
                <p className="text-sm font-bold text-slate-800">Sustainable Livelihood Program</p>
                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Department of Social Welfare and Development</p>
             </div>
          </div>
        </header>

        <div className="flex-1 p-4 lg:p-8 overflow-y-auto">
          <div className="max-w-7xl mx-auto w-full">
            {activeTab === 'chat' && <ChatView />}
            {activeTab === 'docs' && <DocsView role={profile?.role || (user?.email === 'marvitoriolopez30@gmail.com' ? 'admin' : 'user')} />}
            {activeTab === 'beneficiaries' && <BeneficiaryView />}
            {activeTab === 'admin' && (profile?.role === 'admin' || user?.email === 'marvitoriolopez30@gmail.com') && <AdminView />}
          </div>
        </div>

        <footer className="p-6 text-center text-slate-400 text-xs font-medium border-t border-slate-100 shrink-0">
          © MVLTORIO 2026 • SLP Knowledge Assistant v1.0
        </footer>
      </main>
    </div>
  );
}

// --- Views ---

function ChatView() {
  const [messages, setMessages] = useState<any[]>([
    { role: 'assistant', content: 'Hello! I am your SLP Knowledge Assistant. How can I help you today? I can answer questions about policies, retrieve templates, or analyze SLP guidelines.' }
  ]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isTyping) return;

    const userMsg = { role: 'user', content: input };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setIsTyping(true);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          message: input,
          history: messages.slice(-5) // Send last 5 messages for context
        })
      });

      const data = await response.json();
      setMessages(prev => [...prev, { 
        role: 'assistant', 
        content: data.answer,
        sources: data.sources
      }]);
    } catch (error) {
      console.error('Chat error:', error);
      setMessages(prev => [...prev, { role: 'assistant', content: 'Sorry, I encountered an error processing your request.' }]);
    } finally {
      setIsTyping(false);
    }
  };

  return (
    <div className="h-full flex flex-col max-w-4xl mx-auto">
      <div className="flex-1 space-y-6 pb-6">
        {messages.map((msg, i) => (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            key={i}
            className={cn(
              "flex gap-4",
              msg.role === 'user' ? "flex-row-reverse" : ""
            )}
          >
            <div className={cn(
              "w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 shadow-sm",
              msg.role === 'user' ? "bg-slate-800 text-white" : "bg-emerald-600 text-white"
            )}>
              {msg.role === 'user' ? <Users size={16} /> : <BarChart3 size={16} />}
            </div>
            <div className={cn(
              "max-w-[80%] rounded-2xl px-4 py-3 shadow-sm border",
              msg.role === 'user' 
                ? "bg-white border-slate-200 text-slate-700" 
                : "bg-white border-emerald-100 text-slate-700"
            )}>
              <div className="prose prose-sm max-w-none prose-emerald">
                <ReactMarkdown>{msg.content}</ReactMarkdown>
              </div>
              
              {msg.sources && msg.sources.length > 0 && (
                <div className="mt-4 pt-4 border-t border-slate-100">
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Sources</p>
                  <div className="flex flex-wrap gap-2">
                    {msg.sources.map((s: any, j: number) => (
                      <div key={j} className="flex items-center gap-1.5 bg-slate-50 border border-slate-200 px-2 py-1 rounded text-[10px] font-medium text-slate-600">
                        <FileText size={10} />
                        {s.file_name}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        ))}
        {isTyping && (
          <div className="flex gap-4">
            <div className="w-8 h-8 rounded-lg bg-emerald-600 text-white flex items-center justify-center flex-shrink-0 animate-pulse">
              <BarChart3 size={16} />
            </div>
            <div className="bg-white border border-emerald-100 rounded-2xl px-4 py-3 shadow-sm">
              <div className="flex gap-1">
                <div className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <div className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <div className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
            </div>
          </div>
        )}
        <div ref={scrollRef} />
      </div>

      <form onSubmit={handleSend} className="sticky bottom-0 bg-slate-50 pt-4 pb-2">
        <div className="relative">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask an SLP question..."
            className="w-full bg-white border border-slate-200 rounded-2xl px-6 py-4 pr-14 shadow-lg focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
          />
          <button
            type="submit"
            disabled={!input.trim() || isTyping}
            className="absolute right-2 top-2 bottom-2 w-10 bg-emerald-600 text-white rounded-xl flex items-center justify-center hover:bg-emerald-700 disabled:opacity-50 disabled:hover:bg-emerald-600 transition-colors"
          >
            <Send size={18} />
          </button>
        </div>
        <p className="text-[10px] text-center text-slate-400 mt-3 font-medium">
          AI can make mistakes. Check important info.
        </p>
      </form>
    </div>
  );
}

function DocsView({ role }: { role?: string }) {
  const [docs, setDocs] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedFolder, setSelectedFolder] = useState<string | 'ALL'>('ALL');
  const [search, setSearch] = useState('');
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadFiles, setUploadFiles] = useState<FileList | null>(null);
  const [folder, setFolder] = useState(FOLDERS[0]);

  useEffect(() => {
    fetchDocs();
  }, []);

  const fetchDocs = async () => {
    const { data, error } = await supabase
      .from('documents')
      .select('*')
      .order('created_at', { ascending: false });
    
    if (error) console.error(error);
    else setDocs(data || []);
    setLoading(false);
  };

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!uploadFiles || uploadFiles.length === 0) return;

    setUploading(true);
    try {
      for (let i = 0; i < uploadFiles.length; i++) {
        const file = uploadFiles[i];
        const fileName = `${Date.now()}_${file.name}`;
        const filePath = `${folder}/${fileName}`;

        // 1. Upload to Supabase Storage
        const { error: uploadError } = await supabase.storage
          .from('knowledge')
          .upload(filePath, file);

        if (uploadError) throw uploadError;

        const { data: { publicUrl } } = supabase.storage
          .from('knowledge')
          .getPublicUrl(filePath);

        // 2. Save to Database
        const { data: docData, error: dbError } = await supabase
          .from('documents')
          .insert({
            file_name: file.name,
            file_url: publicUrl,
            folder: folder,
            content_text: '' // Will be processed by server
          })
          .select()
          .single();

        if (dbError) throw dbError;

        // 3. Trigger Server Processing (OCR/Text Extraction)
        await fetch('/api/admin/process-document', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            documentId: docData.id,
            fileUrl: publicUrl,
            fileName: file.name,
            folder: folder
          })
        });
      }

      alert('Documents uploaded and processing started!');
      setIsUploadOpen(false);
      setUploadFiles(null);
      fetchDocs();
    } catch (error: any) {
      handleUploadError(error);
    } finally {
      setUploading(false);
    }
  };

  const filteredDocs = docs.filter(d => 
    (selectedFolder === 'ALL' || d.folder === selectedFolder) &&
    (d.file_name.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-800">Knowledge Base</h2>
          <p className="text-slate-500 text-sm">Access official SLP guidelines, forms, and reports.</p>
        </div>
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
            <input 
              type="text" 
              placeholder="Search files..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-10 pr-4 py-2 bg-white border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 w-full sm:w-64"
            />
          </div>
          {role === 'admin' && (
            <button 
              onClick={() => setIsUploadOpen(true)}
              className="flex items-center justify-center gap-2 bg-emerald-600 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-emerald-700 transition-all shadow-lg shadow-emerald-100"
            >
              <Plus size={18} />
              Upload
            </button>
          )}
        </div>
      </div>

      {/* Upload Modal */}
      <AnimatePresence>
        {isUploadOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm">
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden"
            >
              <div className="p-6 border-b border-slate-100 flex items-center justify-between">
                <h3 className="text-lg font-bold text-slate-800">Upload Knowledge</h3>
                <button onClick={() => setIsUploadOpen(false)} className="text-slate-400 hover:text-slate-600">
                  <X size={20} />
                </button>
              </div>
              <form onSubmit={handleUpload} className="p-6 space-y-4">
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Select Folder</label>
                  <select 
                    value={folder}
                    onChange={(e) => setFolder(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                  >
                    {FOLDERS.map(f => <option key={f} value={f}>{f}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Files</label>
                  <input 
                    type="file"
                    required
                    multiple
                    onChange={(e) => setUploadFiles(e.target.files)}
                    className="w-full text-sm text-slate-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-xs file:font-bold file:bg-emerald-50 file:text-emerald-700 hover:file:bg-emerald-100"
                  />
                </div>
                <button 
                  type="submit"
                  disabled={uploading || !uploadFiles}
                  className="w-full bg-emerald-600 text-white font-bold py-3 rounded-xl hover:bg-emerald-700 transition-all disabled:opacity-50"
                >
                  {uploading ? "Uploading..." : "Start Upload"}
                </button>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setSelectedFolder('ALL')}
          className={cn(
            "px-4 py-2 rounded-lg text-sm font-semibold transition-all",
            selectedFolder === 'ALL' ? "bg-emerald-600 text-white shadow-md shadow-emerald-100" : "bg-white text-slate-600 border border-slate-200 hover:bg-slate-50"
          )}
        >
          All Files
        </button>
        {FOLDERS.map(f => (
          <button
            key={f}
            onClick={() => setSelectedFolder(f)}
            className={cn(
              "px-4 py-2 rounded-lg text-sm font-semibold transition-all",
              selectedFolder === f ? "bg-emerald-600 text-white shadow-md shadow-emerald-100" : "bg-white text-slate-600 border border-slate-200 hover:bg-slate-50"
            )}
          >
            {f}
          </button>
        ))}
      </div>

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th className="px-6 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">File Name</th>
                <th className="px-6 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Folder</th>
                <th className="px-6 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Date Uploaded</th>
                <th className="px-6 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredDocs.length > 0 ? filteredDocs.map(doc => (
                <tr key={doc.id} className="hover:bg-slate-50 transition-colors group">
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 bg-blue-50 text-blue-600 rounded flex items-center justify-center">
                        <FileText size={16} />
                      </div>
                      <span className="text-sm font-semibold text-slate-700">{doc.file_name}</span>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <span className="text-xs font-bold px-2 py-1 bg-slate-100 text-slate-600 rounded">
                      {doc.folder}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-xs text-slate-500 font-medium">
                    {new Date(doc.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <a 
                      href={doc.file_url} 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 bg-white border border-slate-200 text-slate-600 px-3 py-1.5 rounded-lg text-xs font-bold hover:bg-emerald-600 hover:text-white hover:border-emerald-600 transition-all"
                    >
                      <Download size={14} />
                      Download
                    </a>
                  </td>
                </tr>
              )) : (
                <tr>
                  <td colSpan={4} className="px-6 py-12 text-center text-slate-400 font-medium">
                    No documents found in this category.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function BeneficiaryView() {
  const [search, setSearch] = useState('');
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!search.trim()) return;

    setLoading(true);
    try {
      const response = await fetch('/api/beneficiaries/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: search })
      });
      const data = await response.json();
      setResult(data);
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      <div className="text-center space-y-2">
        <h2 className="text-3xl font-bold text-slate-800">Beneficiary Verification</h2>
        <p className="text-slate-500">Search the SLP database to verify if a beneficiary has already been served.</p>
      </div>

      <form onSubmit={handleSearch} className="relative">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Enter full name (e.g. Juan Dela Cruz)"
          className="w-full bg-white border border-slate-200 rounded-2xl px-6 py-5 pr-14 shadow-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all text-lg font-medium"
        />
        <button
          type="submit"
          disabled={loading}
          className="absolute right-3 top-3 bottom-3 w-12 bg-emerald-600 text-white rounded-xl flex items-center justify-center hover:bg-emerald-700 disabled:opacity-50 transition-colors shadow-lg shadow-emerald-200"
        >
          {loading ? <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1 }}><Clock size={20} /></motion.div> : <Search size={20} />}
        </button>
      </form>

      <AnimatePresence>
        {result && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="space-y-6"
          >
            {result.bestMatch ? (
              <Card className="p-8 border-emerald-200 bg-emerald-50/30">
                <div className="flex items-center justify-between mb-6">
                  <div className="flex items-center gap-4">
                    <div className="w-14 h-14 bg-emerald-100 text-emerald-600 rounded-2xl flex items-center justify-center shadow-inner">
                      <Users size={28} />
                    </div>
                    <div>
                      <p className="text-[10px] font-bold text-emerald-600 uppercase tracking-widest">Best Match Found</p>
                      <h3 className="text-2xl font-bold text-slate-800">{result.bestMatch.name}</h3>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Similarity</p>
                    <p className="text-3xl font-black text-emerald-600">{result.bestMatch.similarity}%</p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="bg-white p-4 rounded-xl border border-emerald-100 shadow-sm">
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Status</p>
                    <div className="flex items-center gap-2">
                      <div className={cn(
                        "w-2 h-2 rounded-full",
                        result.bestMatch.status === 'Served' ? "bg-emerald-500" : "bg-amber-500"
                      )} />
                      <p className="text-lg font-bold text-slate-700">{result.bestMatch.status}</p>
                    </div>
                  </div>
                  <div className="bg-white p-4 rounded-xl border border-emerald-100 shadow-sm">
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Verification</p>
                    <p className="text-lg font-bold text-slate-700">
                      {result.bestMatch.similarity > 90 ? "Highly Likely" : "Potential Match"}
                    </p>
                  </div>
                </div>
              </Card>
            ) : (
              <Card className="p-12 text-center border-slate-200 bg-slate-50">
                <div className="w-16 h-16 bg-slate-200 text-slate-400 rounded-full flex items-center justify-center mx-auto mb-4">
                  <XCircle size={32} />
                </div>
                <h3 className="text-xl font-bold text-slate-700">No Match Found</h3>
                <p className="text-slate-500">We couldn't find any beneficiary with that name in our database.</p>
              </Card>
            )}

            {result.allResults && result.allResults.length > 1 && (
              <div className="space-y-3">
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest px-2">Other Potential Matches</p>
                {result.allResults.slice(1, 4).map((r: any, i: number) => (
                  <div key={i} className="bg-white border border-slate-200 p-4 rounded-xl flex items-center justify-between hover:border-emerald-300 transition-colors cursor-pointer group">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 bg-slate-100 text-slate-400 rounded-lg flex items-center justify-center group-hover:bg-emerald-50 group-hover:text-emerald-600 transition-colors">
                        <Users size={16} />
                      </div>
                      <span className="font-bold text-slate-700">{r.name}</span>
                    </div>
                    <div className="flex items-center gap-4">
                      <span className="text-xs font-bold text-slate-400">{r.status}</span>
                      <span className="text-sm font-black text-slate-600">{r.similarity}%</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function AdminView() {
  const [users, setUsers] = useState<Profile[]>([]);
  const [docs, setDocs] = useState<Document[]>([]);
  const [activeSubTab, setActiveSubTab] = useState<'users' | 'files' | 'stats' | 'beneficiaries' | 'health'>('users');
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [isAddUserOpen, setIsAddUserOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<Profile | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadFiles, setUploadFiles] = useState<FileList | null>(null);
  const [uploadFolder, setUploadFolder] = useState(FOLDERS[0]);
  const [healthStatus, setHealthStatus] = useState<{
    profilesTable: boolean;
    documentsTable: boolean;
    beneficiariesTable: boolean;
    knowledgeBucket: boolean;
    checking: boolean;
  }>({
    profilesTable: true,
    documentsTable: true,
    beneficiariesTable: true,
    knowledgeBucket: true,
    checking: false
  });

  // New User State
  const [newUserEmail, setNewUserEmail] = useState('');
  const [newUserFullName, setNewUserFullName] = useState('');
  const [newUserRole, setNewUserRole] = useState<UserRole>('user');
  const [newUserStatus, setNewUserStatus] = useState<UserStatus>('approved');
  const [beneficiaries, setBeneficiaries] = useState<any[]>([]);
  const [isAddBeneficiaryOpen, setIsAddBeneficiaryOpen] = useState(false);
  const [newBeneficiaryName, setNewBeneficiaryName] = useState('');
  const [newBeneficiaryStatus, setNewBeneficiaryStatus] = useState('Served');
  const [editingBeneficiary, setEditingBeneficiary] = useState<any>(null);

  useEffect(() => {
    fetchAdminData();
    checkSystemHealth();
  }, []);

  const checkSystemHealth = async () => {
    setHealthStatus(prev => ({ ...prev, checking: true }));
    
    // Check Profiles Table
    const { error: pError } = await supabase.from('profiles').select('id').limit(1);
    const pTable = !pError || !pError.message.includes('relation "public.profiles" does not exist');
    
    // Check Documents Table
    const { error: dError } = await supabase.from('documents').select('id').limit(1);
    const dTable = !dError || !dError.message.includes('relation "public.documents" does not exist');

    // Check Beneficiaries Table
    const { error: bError } = await supabase.from('beneficiaries').select('id').limit(1);
    const bTable = !bError || !bError.message.includes('relation "public.beneficiaries" does not exist');

    // Check Knowledge Bucket
    const { data: bucket, error: bucketError } = await supabase.storage.getBucket('knowledge');
    const kBucket = !!bucket && !bucketError;

    setHealthStatus({
      profilesTable: pTable,
      documentsTable: dTable,
      beneficiariesTable: bTable,
      knowledgeBucket: kBucket,
      checking: false
    });
  };

  const fetchAdminData = async () => {
    const { data: userData } = await supabase.from('profiles').select('*').order('created_at', { ascending: false });
    const { data: docData } = await supabase.from('documents').select('*').order('created_at', { ascending: false });
    const { data: benData } = await supabase.from('beneficiaries').select('*').order('name', { ascending: true });
    
    // Sort users so pending ones are at the top
    const sortedUsers = (userData || []).sort((a, b) => {
      if (a.status === 'pending' && b.status !== 'pending') return -1;
      if (a.status !== 'pending' && b.status === 'pending') return 1;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });

    setUsers(sortedUsers);
    setDocs(docData || []);
    setBeneficiaries(benData || []);
  };

  const updateUserStatus = async (userId: string, status: UserStatus) => {
    const { error } = await supabase.from('profiles').update({ status }).eq('id', userId);
    if (error) alert(error.message);
    fetchAdminData();
  };

  const updateUserRole = async (userId: string, role: 'admin' | 'user') => {
    const { error } = await supabase.from('profiles').update({ role }).eq('id', userId);
    if (error) alert(error.message);
    fetchAdminData();
  };

  const deleteUser = async (userId: string) => {
    if (!confirm('Are you sure you want to delete this user? This will not delete their Auth account, only their profile.')) return;
    const { error } = await supabase.from('profiles').delete().eq('id', userId);
    if (error) alert(error.message);
    fetchAdminData();
  };

  const deleteFile = async (docId: string) => {
    if (!confirm('Are you sure you want to delete this document?')) return;
    const { error } = await supabase.from('documents').delete().eq('id', docId);
    if (error) alert(error.message);
    fetchAdminData();
  };

  const handleAddUser = async (e: React.FormEvent) => {
    e.preventDefault();
    const { error } = await supabase.from('profiles').insert({
      email: newUserEmail,
      full_name: newUserFullName,
      role: newUserRole,
      status: newUserStatus,
      id: crypto.randomUUID() // Note: This is just a profile, they still need to sign up
    });
    if (error) alert(error.message);
    else {
      setIsAddUserOpen(false);
      setNewUserEmail('');
      setNewUserFullName('');
      fetchAdminData();
    }
  };

  const handleEditUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingUser) return;
    const { error } = await supabase.from('profiles').update({
      full_name: editingUser.full_name,
      role: editingUser.role,
      status: editingUser.status
    }).eq('id', editingUser.id);
    if (error) alert(error.message);
    else {
      setEditingUser(null);
      fetchAdminData();
    }
  };

  const handleAddBeneficiary = async (e: React.FormEvent) => {
    e.preventDefault();
    const { error } = await supabase.from('beneficiaries').insert({
      name: newBeneficiaryName,
      status: newBeneficiaryStatus
    });
    if (error) alert(error.message);
    else {
      setIsAddBeneficiaryOpen(false);
      setNewBeneficiaryName('');
      fetchAdminData();
    }
  };

  const handleEditBeneficiary = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingBeneficiary) return;
    const { error } = await supabase.from('beneficiaries').update({
      name: editingBeneficiary.name,
      status: editingBeneficiary.status
    }).eq('id', editingBeneficiary.id);
    if (error) alert(error.message);
    else {
      setEditingBeneficiary(null);
      fetchAdminData();
    }
  };

  const deleteBeneficiary = async (id: string) => {
    if (!confirm('Are you sure you want to delete this beneficiary?')) return;
    const { error } = await supabase.from('beneficiaries').delete().eq('id', id);
    if (error) alert(error.message);
    fetchAdminData();
  };

  const handleBulkUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!uploadFiles || uploadFiles.length === 0) return;

    setUploading(true);
    try {
      for (let i = 0; i < uploadFiles.length; i++) {
        const file = uploadFiles[i];
        const fileName = `${Date.now()}_${file.name}`;
        const filePath = `${uploadFolder}/${fileName}`;

        const { error: uploadError } = await supabase.storage
          .from('knowledge')
          .upload(filePath, file);

        if (uploadError) throw uploadError;

        const { data: { publicUrl } } = supabase.storage
          .from('knowledge')
          .getPublicUrl(filePath);

        const { data: doc, error: dbError } = await supabase
          .from('documents')
          .insert({
            file_name: file.name,
            folder: uploadFolder,
            file_url: publicUrl,
            uploaded_by: (await supabase.auth.getUser()).data.user?.id
          })
          .select()
          .single();

        if (dbError) throw dbError;

        // Trigger RAG processing
        await fetch('/api/admin/process-document', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            documentId: doc.id,
            fileUrl: publicUrl,
            fileName: file.name,
            folder: uploadFolder
          })
        });
      }

      alert('Bulk upload completed!');
      setIsUploadOpen(false);
      setUploadFiles(null);
      fetchAdminData();
    } catch (error: any) {
      handleUploadError(error);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-6 lg:space-y-8">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-800">Admin Dashboard</h2>
          <p className="text-slate-500 text-sm">Manage users, documents, and system settings.</p>
        </div>
        <div className="flex bg-white border border-slate-200 rounded-xl p-1 shadow-sm overflow-x-auto no-scrollbar">
          <button 
            onClick={() => setActiveSubTab('users')}
            className={cn(
              "px-4 py-2 rounded-lg text-xs font-bold transition-all whitespace-nowrap flex items-center gap-2", 
              activeSubTab === 'users' ? "bg-slate-800 text-white" : "text-slate-500 hover:bg-slate-50"
            )}
          >
            User Accounts
            {users.filter(u => u.status === 'pending').length > 0 && (
              <span className="bg-amber-500 text-white text-[8px] px-1.5 py-0.5 rounded-full">
                {users.filter(u => u.status === 'pending').length}
              </span>
            )}
          </button>
          <button 
            onClick={() => setActiveSubTab('beneficiaries')}
            className={cn("px-4 py-2 rounded-lg text-xs font-bold transition-all whitespace-nowrap", activeSubTab === 'beneficiaries' ? "bg-slate-800 text-white" : "text-slate-500 hover:bg-slate-50")}
          >
            Name Matching Data
          </button>
          <button 
            onClick={() => setActiveSubTab('files')}
            className={cn("px-4 py-2 rounded-lg text-xs font-bold transition-all whitespace-nowrap", activeSubTab === 'files' ? "bg-slate-800 text-white" : "text-slate-500 hover:bg-slate-50")}
          >
            Knowledge Base
          </button>
          <button 
            onClick={() => setActiveSubTab('stats')}
            className={cn("px-4 py-2 rounded-lg text-xs font-bold transition-all whitespace-nowrap", activeSubTab === 'stats' ? "bg-slate-800 text-white" : "text-slate-500 hover:bg-slate-50")}
          >
            System Stats
          </button>
          <button 
            onClick={() => setActiveSubTab('health')}
            className={cn(
              "px-4 py-2 rounded-lg text-xs font-bold transition-all whitespace-nowrap flex items-center gap-2", 
              activeSubTab === 'health' ? "bg-slate-800 text-white" : "text-slate-500 hover:bg-slate-50"
            )}
          >
            System Health
            {(!healthStatus.profilesTable || !healthStatus.documentsTable || !healthStatus.beneficiariesTable || !healthStatus.knowledgeBucket) && (
              <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
            )}
          </button>
        </div>
      </div>

      {activeSubTab === 'health' && (
        <div className="space-y-6">
          <Card className="p-6">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h3 className="text-lg font-bold text-slate-800">System Configuration Check</h3>
                <p className="text-sm text-slate-500">Verify that all required database tables and storage buckets are correctly configured.</p>
              </div>
              <button 
                onClick={checkSystemHealth}
                disabled={healthStatus.checking}
                className="text-xs font-bold text-emerald-600 hover:text-emerald-700 disabled:opacity-50"
              >
                {healthStatus.checking ? 'Checking...' : 'Refresh Status'}
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <HealthCard 
                title="Profiles Table" 
                status={healthStatus.profilesTable} 
                description="Stores user accounts and permissions."
                fix="CREATE TABLE profiles (id UUID REFERENCES auth.users PRIMARY KEY, email TEXT, full_name TEXT, role TEXT, status TEXT);"
              />
              <HealthCard 
                title="Documents Table" 
                status={healthStatus.documentsTable} 
                description="Stores metadata for uploaded knowledge files."
                fix="CREATE TABLE documents (id UUID DEFAULT gen_random_uuid() PRIMARY KEY, file_name TEXT, file_url TEXT, folder TEXT, content_text TEXT, created_at TIMESTAMPTZ DEFAULT NOW());"
              />
              <HealthCard 
                title="Beneficiaries Table" 
                status={healthStatus.beneficiariesTable} 
                description="Stores data for name matching features."
                fix="CREATE TABLE beneficiaries (id UUID DEFAULT gen_random_uuid() PRIMARY KEY, name TEXT, region TEXT, province TEXT, city TEXT, status TEXT);"
              />
              <HealthCard 
                title="Knowledge Bucket" 
                status={healthStatus.knowledgeBucket} 
                description="Supabase Storage bucket for PDF/DOCX files."
                fix="Go to Storage -> New Bucket -> Name it 'knowledge' -> Set to Public."
              />
            </div>
          </Card>
        </div>
      )}

      {activeSubTab === 'users' && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button 
              onClick={() => setIsAddUserOpen(true)}
              className="flex items-center gap-2 bg-emerald-600 text-white px-4 py-2 rounded-xl text-sm font-bold hover:bg-emerald-700 transition-all shadow-lg shadow-emerald-100"
            >
              <Plus size={18} />
              Add User
            </button>
          </div>
          <Card>
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <th className="px-6 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Full Name</th>
                    <th className="px-6 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Email</th>
                    <th className="px-6 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Role</th>
                    <th className="px-6 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Status</th>
                    <th className="px-6 py-4 text-right text-[10px] font-bold text-slate-400 uppercase tracking-widest">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {users.map(u => (
                    <tr key={u.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-6 py-4">
                        <span className="text-sm font-bold text-slate-700">{u.full_name || 'N/A'}</span>
                      </td>
                      <td className="px-6 py-4 text-sm font-semibold text-slate-700">{u.email}</td>
                      <td className="px-6 py-4">
                        <span className={cn(
                          "text-[10px] font-bold px-2 py-0.5 rounded-full",
                          u.role === 'admin' ? "bg-purple-100 text-purple-700" : "bg-blue-100 text-blue-700"
                        )}>
                          {u.role.toUpperCase()}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <span className={cn(
                          "text-[10px] font-bold px-2 py-0.5 rounded-full",
                          u.status === 'approved' ? "bg-emerald-100 text-emerald-700" : 
                          u.status === 'pending' ? "bg-amber-100 text-amber-700" : "bg-red-100 text-red-700"
                        )}>
                          {u.status.toUpperCase()}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-right space-x-2">
                        <div className="flex items-center justify-end gap-2">
                          {u.status === 'pending' && (
                            <>
                              <button 
                                onClick={() => updateUserStatus(u.id, 'approved')}
                                className="p-1.5 text-emerald-600 hover:bg-emerald-50 rounded-lg transition-colors"
                                title="Approve"
                              >
                                <CheckCircle size={18} />
                              </button>
                              <button 
                                onClick={() => updateUserStatus(u.id, 'rejected')}
                                className="p-1.5 text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                                title="Reject"
                              >
                                <XCircle size={18} />
                              </button>
                            </>
                          )}
                          <button 
                            onClick={() => setEditingUser(u)}
                            className="p-1.5 text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                            title="Edit User"
                          >
                            <Settings size={18} />
                          </button>
                          <button 
                            onClick={() => deleteUser(u.id)}
                            className="p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600 rounded-lg transition-colors"
                            title="Delete Profile"
                          >
                            <Trash2 size={18} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      {activeSubTab === 'beneficiaries' && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button 
              onClick={() => setIsAddBeneficiaryOpen(true)}
              className="flex items-center gap-2 bg-emerald-600 text-white px-4 py-2 rounded-xl text-sm font-bold hover:bg-emerald-700 transition-all shadow-lg shadow-emerald-100"
            >
              <Plus size={18} />
              Add Beneficiary
            </button>
          </div>
          <Card>
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <th className="px-6 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Name</th>
                    <th className="px-6 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Status</th>
                    <th className="px-6 py-4 text-right text-[10px] font-bold text-slate-400 uppercase tracking-widest">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {beneficiaries.map(b => (
                    <tr key={b.id} className="hover:bg-slate-50/50 transition-colors">
                      <td className="px-6 py-4">
                        <span className="text-sm font-bold text-slate-700">{b.name}</span>
                      </td>
                      <td className="px-6 py-4">
                        <span className={cn(
                          "text-[10px] font-bold px-2 py-1 rounded-full uppercase tracking-wider",
                          b.status === 'Served' ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"
                        )}>
                          {b.status}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button 
                            onClick={() => setEditingBeneficiary(b)}
                            className="p-2 text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg transition-all"
                          >
                            <Edit2 size={16} />
                          </button>
                          <button 
                            onClick={() => deleteBeneficiary(b.id)}
                            className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      {activeSubTab === 'files' && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button 
              onClick={() => setIsUploadOpen(true)}
              className="flex items-center gap-2 bg-emerald-600 text-white px-4 py-2 rounded-xl text-sm font-bold hover:bg-emerald-700 transition-all shadow-lg shadow-emerald-100"
            >
              <Plus size={18} />
              Add / Bulk Upload Files
            </button>
          </div>
          <Card>
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <th className="px-6 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">File Name</th>
                    <th className="px-6 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Folder</th>
                    <th className="px-6 py-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {docs.map(doc => (
                    <tr key={doc.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-6 py-4 text-sm font-semibold text-slate-700">{doc.file_name}</td>
                      <td className="px-6 py-4">
                        <span className="text-xs font-bold px-2 py-1 bg-slate-100 text-slate-600 rounded">
                          {doc.folder}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-right">
                        <button 
                          onClick={() => deleteFile(doc.id)}
                          className="p-1.5 text-red-400 hover:bg-red-50 hover:text-red-600 rounded-lg transition-all"
                        >
                          <Trash2 size={16} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      {/* Add User Modal */}
      <AnimatePresence>
        {isAddUserOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm">
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden"
            >
              <div className="p-6 border-b border-slate-100 flex items-center justify-between">
                <h3 className="text-lg font-bold text-slate-800">Add New User</h3>
                <button onClick={() => setIsAddUserOpen(false)} className="text-slate-400 hover:text-slate-600">
                  <X size={20} />
                </button>
              </div>
              <form onSubmit={handleAddUser} className="p-6 space-y-4">
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Email Address</label>
                  <input 
                    type="email"
                    required
                    value={newUserEmail}
                    onChange={(e) => setNewUserEmail(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                    placeholder="user@example.com"
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Role</label>
                    <select 
                      value={newUserRole}
                      onChange={(e) => setNewUserRole(e.target.value as UserRole)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                    >
                      <option value="user">User</option>
                      <option value="admin">Admin</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Status</label>
                    <select 
                      value={newUserStatus}
                      onChange={(e) => setNewUserStatus(e.target.value as UserStatus)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                    >
                      <option value="approved">Approved</option>
                      <option value="pending">Pending</option>
                    </select>
                  </div>
                </div>
                <button 
                  type="submit"
                  className="w-full bg-emerald-600 text-white font-bold py-3 rounded-xl hover:bg-emerald-700 transition-all shadow-lg shadow-emerald-100"
                >
                  Create User Profile
                </button>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Edit User Modal */}
      <AnimatePresence>
        {editingUser && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm">
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden"
            >
              <div className="p-6 border-b border-slate-100 flex items-center justify-between">
                <h3 className="text-lg font-bold text-slate-800">Edit User Profile</h3>
                <button onClick={() => setEditingUser(null)} className="text-slate-400 hover:text-slate-600">
                  <X size={20} />
                </button>
              </div>
              <form onSubmit={handleEditUser} className="p-6 space-y-4">
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Full Name</label>
                  <input 
                    type="text"
                    required
                    value={editingUser.full_name || ''}
                    onChange={(e) => setEditingUser({...editingUser, full_name: e.target.value})}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Email Address</label>
                  <input 
                    type="email"
                    disabled
                    value={editingUser.email}
                    className="w-full bg-slate-100 border border-slate-200 rounded-xl px-4 py-3 text-slate-500"
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Role</label>
                    <select 
                      value={editingUser.role}
                      onChange={(e) => setEditingUser({...editingUser, role: e.target.value as UserRole})}
                      className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                    >
                      <option value="user">User</option>
                      <option value="admin">Admin</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Status</label>
                    <select 
                      value={editingUser.status}
                      onChange={(e) => setEditingUser({...editingUser, status: e.target.value as UserStatus})}
                      className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                    >
                      <option value="approved">Approved</option>
                      <option value="pending">Pending</option>
                      <option value="rejected">Rejected</option>
                    </select>
                  </div>
                </div>
                <button 
                  type="submit"
                  className="w-full bg-emerald-600 text-white font-bold py-3 rounded-xl hover:bg-emerald-700 transition-all shadow-lg shadow-emerald-100"
                >
                  Save Changes
                </button>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Add Beneficiary Modal */}
      <AnimatePresence>
        {isAddBeneficiaryOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm">
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden"
            >
              <div className="p-6 border-b border-slate-100 flex items-center justify-between">
                <h3 className="text-lg font-bold text-slate-800">Add Beneficiary</h3>
                <button onClick={() => setIsAddBeneficiaryOpen(false)} className="text-slate-400 hover:text-slate-600">
                  <X size={20} />
                </button>
              </div>
              <form onSubmit={handleAddBeneficiary} className="p-6 space-y-4">
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Full Name</label>
                  <input 
                    type="text"
                    required
                    value={newBeneficiaryName}
                    onChange={(e) => setNewBeneficiaryName(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                    placeholder="Juan Dela Cruz"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Status</label>
                  <select 
                    value={newBeneficiaryStatus}
                    onChange={(e) => setNewBeneficiaryStatus(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                  >
                    <option value="Served">Served</option>
                    <option value="Not Served">Not Served</option>
                  </select>
                </div>
                <button 
                  type="submit"
                  className="w-full bg-emerald-600 text-white font-bold py-3 rounded-xl hover:bg-emerald-700 transition-all shadow-lg shadow-emerald-100"
                >
                  Add Beneficiary
                </button>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Edit Beneficiary Modal */}
      <AnimatePresence>
        {editingBeneficiary && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm">
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden"
            >
              <div className="p-6 border-b border-slate-100 flex items-center justify-between">
                <h3 className="text-lg font-bold text-slate-800">Edit Beneficiary</h3>
                <button onClick={() => setEditingBeneficiary(null)} className="text-slate-400 hover:text-slate-600">
                  <X size={20} />
                </button>
              </div>
              <form onSubmit={handleEditBeneficiary} className="p-6 space-y-4">
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Full Name</label>
                  <input 
                    type="text"
                    required
                    value={editingBeneficiary.name}
                    onChange={(e) => setEditingBeneficiary({...editingBeneficiary, name: e.target.value})}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Status</label>
                  <select 
                    value={editingBeneficiary.status}
                    onChange={(e) => setEditingBeneficiary({...editingBeneficiary, status: e.target.value})}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                  >
                    <option value="Served">Served</option>
                    <option value="Not Served">Not Served</option>
                  </select>
                </div>
                <button 
                  type="submit"
                  className="w-full bg-emerald-600 text-white font-bold py-3 rounded-xl hover:bg-emerald-700 transition-all shadow-lg shadow-emerald-100"
                >
                  Save Changes
                </button>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Bulk Upload Modal */}
      <AnimatePresence>
        {isUploadOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm">
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden"
            >
              <div className="p-6 border-b border-slate-100 flex items-center justify-between">
                <h3 className="text-lg font-bold text-slate-800">Bulk Knowledge Upload</h3>
                <button onClick={() => setIsUploadOpen(false)} className="text-slate-400 hover:text-slate-600">
                  <X size={20} />
                </button>
              </div>
              <form onSubmit={handleBulkUpload} className="p-6 space-y-4">
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Select Folder</label>
                  <select 
                    value={uploadFolder}
                    onChange={(e) => setUploadFolder(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                  >
                    {FOLDERS.map(f => <option key={f} value={f}>{f}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Select Files</label>
                  <input 
                    type="file"
                    multiple
                    required
                    onChange={(e) => setUploadFiles(e.target.files)}
                    className="w-full text-sm text-slate-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-xs file:font-bold file:bg-emerald-50 file:text-emerald-700 hover:file:bg-emerald-100"
                  />
                  {uploadFiles && (
                    <p className="mt-2 text-xs font-bold text-emerald-600">
                      {uploadFiles.length} files selected
                    </p>
                  )}
                </div>
                <button 
                  type="submit"
                  disabled={uploading || !uploadFiles}
                  className="w-full bg-emerald-600 text-white font-bold py-3 rounded-xl hover:bg-emerald-700 transition-all shadow-lg shadow-emerald-100 disabled:opacity-50"
                >
                  {uploading ? "Uploading and Processing..." : "Start Bulk Upload"}
                </button>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {activeSubTab === 'stats' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Card className="p-6">
            <h3 className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-6">Documents per Folder</h3>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={FOLDERS.map(f => ({ name: f, count: docs.filter(d => d.folder === f).length }))}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                  <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fontSize: 10, fontWeight: 600, fill: '#94a3b8' }} />
                  <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 10, fontWeight: 600, fill: '#94a3b8' }} />
                  <Tooltip 
                    cursor={{ fill: '#f8fafc' }}
                    contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)' }}
                  />
                  <Bar dataKey="count" fill="#059669" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>
          <Card className="p-6">
            <h3 className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-6">User Distribution</h3>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={[
                      { name: 'Admins', value: users.filter(u => u.role === 'admin').length },
                      { name: 'Users', value: users.filter(u => u.role === 'user').length }
                    ]}
                    innerRadius={60}
                    outerRadius={80}
                    paddingAngle={5}
                    dataKey="value"
                  >
                    <Cell fill="#7c3aed" />
                    <Cell fill="#059669" />
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

// --- Auth Pages ---

function AuthPage() {
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      if (!isLogin && password.length < 6) {
        throw new Error('Password should be at least 6 characters.');
      }

      if (isLogin) {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else {
        const { data, error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        
        if (data.user) {
          // Bootstrap Admin: Automatically make this specific email an approved admin
          const isAdmin = email.toLowerCase() === 'marvitoriolopez30@gmail.com';
          
          const { error: profileError } = await supabase.from('profiles').insert({
            id: data.user.id,
            email: data.user.email,
            full_name: fullName,
            role: isAdmin ? 'admin' : 'user',
            status: isAdmin ? 'approved' : 'pending'
          });

          if (profileError) {
            console.error('Profile creation error:', profileError);
            throw new Error(`Auth succeeded but profile creation failed: ${profileError.message}. Ensure you have run the SQL schema in Supabase.`);
          }

          if (isAdmin) {
            alert('Admin account created and approved automatically! You can now sign in.');
            setIsLogin(true);
          } else {
            alert('Registration successful! Please wait for admin approval.');
          }
        }
      }
    } catch (err: any) {
      console.error('Auth error:', err);
      let message = err.message || 'An unknown error occurred.';
      
      if (message.includes('Invalid login credentials')) {
        message = 'Invalid login credentials. Have you registered this account yet? If not, please switch to the Register tab below.';
      } else if (message.includes('User already registered')) {
        message = 'This email is already registered. Please switch to the "Login" tab to sign in.';
      } else if (message.includes('Password should be at least 6 characters')) {
        message = 'Password is too short. It must be at least 6 characters long.';
      } else if (message.includes('Could not find the table')) {
        message = 'DATABASE ERROR: The "profiles" table is missing in your Supabase project. \n\nFIX: Go to your Supabase SQL Editor and run the following command:\n\nCREATE TABLE profiles (\n  id UUID REFERENCES auth.users ON DELETE CASCADE PRIMARY KEY,\n  email TEXT,\n  full_name TEXT,\n  role TEXT DEFAULT \'user\',\n  status TEXT DEFAULT \'pending\',\n  created_at TIMESTAMPTZ DEFAULT NOW()\n);';
      } else if (message.includes('Email not confirmed')) {
        message = 'Your email is not confirmed. Please check your inbox (and spam) for a confirmation link. \n\nTIP: You can disable this requirement in your Supabase Dashboard under Authentication -> Settings -> User Sign Up -> Disable "Confirm email".';
      } else if (message.includes('security purposes')) {
        message = 'Too many requests! Please wait a few seconds before trying again. This is a security measure from Supabase.';
      } else if (message.includes('email rate limit exceeded')) {
        message = 'Email rate limit exceeded! Supabase limits how many emails can be sent per hour. \n\nFIX: Please wait about 1 hour, or go to your Supabase Dashboard -> Authentication -> Settings and DISABLE "Confirm email" to log in without needing the email link.';
      }
      
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-emerald-50 flex items-center justify-center p-6">
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="max-w-md w-full"
      >
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-emerald-600 rounded-2xl flex items-center justify-center text-white mx-auto mb-4 shadow-xl shadow-emerald-200">
            <BarChart3 size={32} />
          </div>
          <h1 className="text-3xl font-black text-slate-800 tracking-tight">SLP Knowledge Assistant</h1>
          <p className="text-slate-500 font-medium mt-2">AI-Powered Government Knowledge Platform</p>
        </div>

        <Card className="p-8 shadow-2xl shadow-emerald-100">
          {error && (
            <div className="mb-6 p-4 bg-red-50 border border-red-100 rounded-xl">
              <div className="flex gap-3">
                <XCircle className="text-red-500 shrink-0" size={20} />
                <p className="text-xs text-red-700 font-medium leading-relaxed whitespace-pre-wrap">
                  {error}
                </p>
              </div>
            </div>
          )}
          {isLogin && !error && (
            <div className="mb-6 p-4 bg-blue-50 border border-blue-100 rounded-xl">
              <p className="text-xs text-blue-700 font-medium leading-relaxed">
                <strong>First time here?</strong> You must <strong>Register</strong> your account before you can sign in. Click the link at the bottom of this box.
              </p>
            </div>
          )}
          <form onSubmit={handleAuth} className="space-y-4">
            {!isLogin && (
              <div>
                <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Full Name</label>
                <input
                  type="text"
                  required
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
                  placeholder="Juan Dela Cruz"
                />
              </div>
            )}
            <div>
              <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Email Address</label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
                placeholder="name@agency.gov.ph"
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Password</label>
              <input
                type="password"
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
                placeholder="••••••••"
              />
              {!isLogin && <p className="mt-1 text-[9px] text-slate-400">Must be at least 6 characters.</p>}
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-emerald-600 text-white font-bold py-3 rounded-xl hover:bg-emerald-700 transition-all shadow-lg shadow-emerald-100 disabled:opacity-50 mt-2"
            >
              {loading ? "Processing..." : isLogin ? "Sign In" : "Register Account"}
            </button>
          </form>

          <div className="mt-6 text-center">
            <button 
              onClick={() => setIsLogin(!isLogin)}
              className="text-sm font-bold text-emerald-600 hover:text-emerald-700 transition-colors"
            >
              {isLogin ? "Don't have an account? Register" : "Already have an account? Sign In"}
            </button>
          </div>
        </Card>
      </motion.div>
    </div>
  );
}

function PendingPage({ onSignOut }: { onSignOut: () => void }) {
  return (
    <div className="min-h-screen bg-amber-50 flex items-center justify-center p-6">
      <Card className="max-w-md w-full p-12 text-center shadow-2xl shadow-amber-100">
        <div className="w-20 h-20 bg-amber-100 text-amber-600 rounded-full flex items-center justify-center mx-auto mb-6">
          <Clock size={40} />
        </div>
        <h2 className="text-2xl font-bold text-slate-800">Account Pending</h2>
        <p className="text-slate-500 mt-4 leading-relaxed">
          Your registration has been received. An administrator needs to approve your account before you can access the system.
        </p>
        <button 
          onClick={onSignOut}
          className="mt-8 w-full bg-slate-800 text-white font-bold py-3 rounded-xl hover:bg-slate-900 transition-all"
        >
          Sign Out
        </button>
      </Card>
    </div>
  );
}

function RejectedPage({ onSignOut }: { onSignOut: () => void }) {
  return (
    <div className="min-h-screen bg-red-50 flex items-center justify-center p-6">
      <Card className="max-w-md w-full p-12 text-center shadow-2xl shadow-red-100">
        <div className="w-20 h-20 bg-red-100 text-red-600 rounded-full flex items-center justify-center mx-auto mb-6">
          <XCircle size={40} />
        </div>
        <h2 className="text-2xl font-bold text-slate-800">Access Denied</h2>
        <p className="text-slate-500 mt-4 leading-relaxed">
          Your account request has been rejected. Please contact the system administrator for more information.
        </p>
        <button 
          onClick={onSignOut}
          className="mt-8 w-full bg-slate-800 text-white font-bold py-3 rounded-xl hover:bg-slate-900 transition-all"
        >
          Sign Out
        </button>
      </Card>
    </div>
  );
}
