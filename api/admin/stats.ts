import { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { adminId } = req.query;

    if (!adminId) {
      return res.status(400).json({ error: "Admin ID required" });
    }

    // Verify admin
    const { data: admin } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", adminId)
      .single();

    if (!admin || admin.role !== "admin") {
      return res.status(403).json({ error: "Unauthorized" });
    }

    // Get stats
    const [
      { count: totalUsers },
      { count: approvedUsers },
      { count: pendingUsers },
      { count: adminUsers },
      { count: totalDocuments },
      { count: totalBeneficiaries },
      { count: totalChats },
      { data: documentsPerFolder },
    ] = await Promise.all([
      supabase
        .from("profiles")
        .select("*", { count: "exact", head: true }),
      supabase
        .from("profiles")
        .select("*", { count: "exact", head: true })
        .eq("status", "approved"),
      supabase
        .from("profiles")
        .select("*", { count: "exact", head: true })
        .eq("status", "pending"),
      supabase
        .from("profiles")
        .select("*", { count: "exact", head: true })
        .eq("role", "admin"),
      supabase
        .from("documents")
        .select("*", { count: "exact", head: true }),
      supabase
        .from("beneficiaries")
        .select("*", { count: "exact", head: true }),
      supabase
        .from("chat_logs")
        .select("*", { count: "exact", head: true }),
      supabase
        .from("documents")
        .select("folder")
        .order("created_at", { ascending: false })
        .limit(1000),
    ]);

    // Calculate documents per folder
    const folderCounts: { [key: string]: number } = {};
    documentsPerFolder?.forEach((doc: any) => {
      folderCounts[doc.folder] = (folderCounts[doc.folder] || 0) + 1;
    });

    // Recent activity
    const { data: recentChats } = await supabase
      .from("chat_logs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(10);

    return res.status(200).json({
      stats: {
        totalUsers: totalUsers || 0,
        approvedUsers: approvedUsers || 0,
        pendingUsers: pendingUsers || 0,
        adminUsers: adminUsers || 0,
        totalDocuments: totalDocuments || 0,
        totalBeneficiaries: totalBeneficiaries || 0,
        totalChats: totalChats || 0,
      },
      documentsPerFolder: folderCounts,
      recentActivity: recentChats,
    });
  } catch (error: any) {
    console.error("Error:", error);
    return res.status(500).json({ error: error.message });
  }
}
