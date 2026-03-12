import { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "DELETE") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { userId, documentId } = req.body;

    if (!userId || !documentId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Verify user is admin
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", userId)
      .single();

    if (!profile || profile.role !== "admin") {
      return res.status(403).json({ error: "Unauthorized" });
    }

    // Get document info
    const { data: doc, error: docError } = await supabase
      .from("documents")
      .select("*")
      .eq("id", documentId)
      .single();

    if (docError || !doc) {
      return res.status(404).json({ error: "Document not found" });
    }

    // Delete embeddings and chunks first (cascade should handle this)
    // Then delete document
    const { error: deleteError } = await supabase
      .from("documents")
      .delete()
      .eq("id", documentId);

    if (deleteError) throw deleteError;

    // Delete from storage if exists
    try {
      const fileName = doc.file_name;
      const folder = doc.folder.toLowerCase().replace(/ /g, "-");
      await supabase.storage
        .from("knowledge")
        .remove([`${folder}/${fileName}`]);
    } catch (err) {
      console.error("Error deleting from storage:", err);
      // Don't fail if storage deletion fails
    }

    // Log action
    await supabase.from("storage_audit_log").insert({
      user_id: userId,
      action: "document_deleted",
      file_id: documentId,
      file_name: doc.file_name,
    });

    return res.status(200).json({
      success: true,
      message: "Document deleted successfully",
    });
  } catch (error: any) {
    console.error("Error:", error);
    return res.status(500).json({ error: error.message });
  }
}
