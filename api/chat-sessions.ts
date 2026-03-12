import { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "GET") {
    // Get user's sessions
    try {
      const { userId } = req.query;

      if (!userId) {
        return res.status(400).json({ error: "User ID required" });
      }

      const { data, error } = await supabase
        .from("chat_sessions")
        .select("*")
        .eq("user_id", userId)
        .order("updated_at", { ascending: false });

      if (error) throw error;

      return res.status(200).json({ sessions: data });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  } else if (req.method === "POST") {
    // Create new session
    try {
      const { userId, title = "New Chat" } = req.body;

      if (!userId) {
        return res.status(400).json({ error: "User ID required" });
      }

      const { data, error } = await supabase
        .from("chat_sessions")
        .insert({ user_id: userId, title })
        .select()
        .single();

      if (error) throw error;

      return res.status(200).json({ session: data });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  } else if (req.method === "PUT") {
    // Update session title
    try {
      const { sessionId, title } = req.body;

      if (!sessionId || !title) {
        return res.status(400).json({ error: "Session ID and title required" });
      }

      const { data, error } = await supabase
        .from("chat_sessions")
        .update({ title })
        .eq("id", sessionId)
        .select()
        .single();

      if (error) throw error;

      return res.status(200).json({ session: data });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  } else if (req.method === "DELETE") {
    // Delete session
    try {
      const { sessionId } = req.body;

      if (!sessionId) {
        return res.status(400).json({ error: "Session ID required" });
      }

      const { error } = await supabase
        .from("chat_sessions")
        .delete()
        .eq("id", sessionId);

      if (error) throw error;

      return res.status(200).json({ success: true });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  } else {
    return res.status(405).json({ error: "Method not allowed" });
  }
}
