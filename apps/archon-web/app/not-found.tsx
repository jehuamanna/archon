import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 p-8 text-slate-200">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="text-sm text-slate-400">The URL you opened does not exist.</p>
      <Link href="/" className="text-sm text-sky-400 underline hover:text-sky-300">
        Back to Archon
      </Link>
    </div>
  );
}
