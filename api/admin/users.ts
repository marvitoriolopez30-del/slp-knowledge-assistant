import { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "GET") {
    // Get pending users
    try {
      const { status = "pending", limit = 50, offset = 0 } = req.query;

      const { data, error, count } = await supabase
        .from("profiles")
        .select("id, email, full_name, role, status, created_at, updated_at", { count: "exact" })
        .eq("status", status)
        .range(Number(offset), Number(offset) + Number(limit) - 1)
        .order("created_at", { ascending: false });

      if (error) throw error;

      return res.status(200).json({
        users: data,
        total: count,
        status,
      });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  } else if (req.method === "PUT") {
    // Update user status/role
    try {
      const { adminId, userId, action } = req.body;

      if (!adminId || !userId || !action) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      // Verify requester is admin
      const { data: admin } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", adminId)
        .single();

      if (!admin || admin.role !== "admin") {
        return res.status(403).json({ error: "Unauthorized" });
      }

      let updateData: any = {};

      if (action === "approve") {
        updateData = { status: "approved" };
      } else if (action === "reject") {
        updateData = { status: "rejected" };
      } else if (action === "promote") {
        updateData = { role: "admin" };
      } else if (action === "demote") {
        updateData = { role: "user" };
      } else {
        return res.status(400).json({ error: "Invalid action" });
      }

      const { data, error } = await supabase
        .from("profiles")
        .update(updateData)
        .eq("id", userId)
        .select()
        .single();

      if (error) throw error;

      // Log action
      await supabase.from("storage_audit_log").insert({
        user_id: adminId,
        action: `user_${action}`,
        file_name: data.email,
      });

      return res.status(200).json({
        success: true,
        user: data,
        message: `User ${action}ed successfully`,
      });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  } else {
    return res.status(405).json({ error: "Method not allowed" });
  }
}
