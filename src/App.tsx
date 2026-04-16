import { useState } from "react";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL!,
  import.meta.env.VITE_SUPABASE_ANON_KEY!
);

export default function App() {
  const [uploadFiles, setUploadFiles] = useState<FileList | null>(null);
  const [uploading, setUploading] = useState(false);

  // =========================
  // HANDLE UPLOAD (FIXED)
  // =========================
  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!uploadFiles || uploadFiles.length === 0) {
      alert("No file selected");
      return;
    }

    setUploading(true);

    try {
      for (let i = 0; i < uploadFiles.length; i++) {
        const file = uploadFiles[i];

        const filePath = `${Date.now()}_${file.name}`;

        // 1. Upload file to Supabase Storage
        const { error: uploadError } = await supabase.storage
          .from("knowledge")
          .upload(filePath, file);

        if (uploadError) throw uploadError;

        // 2. Get public URL
        const { data } = supabase.storage
          .from("knowledge")
          .getPublicUrl(filePath);

        const publicUrl = data.publicUrl;

        // 3. Save metadata
        const { data: doc, error: dbError } = await supabase
          .from("documents")
          .insert({
            file_name: file.name,
            file_url: publicUrl,
          })
          .select()
          .single();

        if (dbError) throw dbError;

        // =========================
        // 🔥 FIX: READ FILE TEXT
        // =========================
        const text = await file.text();

        // =========================
        // 🔥 SEND TO BACKEND
        // =========================
        const res = await fetch("/api/process-document", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            documentId: doc.id,
            text: text,
          }),
        });

        const result = await res.json();
        console.log("Processed:", result);
      }

      alert("Upload + processing complete!");
      setUploadFiles(null);
    } catch (err: any) {
      console.error(err);
      alert(err.message);
    } finally {
      setUploading(false);
    }
  };

  // =========================
  // UI
  // =========================
  return (
    <div style={{ padding: 20 }}>
      <h2>SLP Knowledge Assistant</h2>

      <form onSubmit={handleUpload}>
        <input
          type="file"
          multiple
          onChange={(e) => setUploadFiles(e.target.files)}
        />

        <br /><br />

        <button type="submit" disabled={uploading}>
          {uploading ? "Uploading..." : "Upload"}
        </button>
      </form>
    </div>
  );
}