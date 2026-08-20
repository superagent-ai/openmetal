import { sendMagicLink } from "./actions";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; sent?: string }>;
}) {
  const params = await searchParams;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-8 py-16">
      <h1 className="text-3xl font-semibold">Sign in</h1>
      <p className="mt-4 text-base text-[#9b9b9b]">
        We will email you a magic link. Open it to confirm your session.
      </p>
      {params.sent ? (
        <p className="mt-6 rounded-lg bg-[#181818] px-4 py-3 text-sm" role="status">
          Check your inbox for the sign in link. Local mail is available in Inbucket.
        </p>
      ) : null}
      {params.error ? (
        <p className="mt-6 rounded-lg bg-[#181818] px-4 py-3 text-sm text-red-300" role="alert">
          {params.error}
        </p>
      ) : null}
      <form action={sendMagicLink} className="mt-8 space-y-4">
        <label className="block text-sm font-semibold" htmlFor="email">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          className="w-full rounded-lg bg-[#1f1f1f] px-3 py-2 text-base"
          placeholder="you@company.com"
        />
        <button
          type="submit"
          className="rounded-lg bg-white px-3 py-2 text-base font-semibold text-black"
        >
          Send magic link
        </button>
      </form>
    </main>
  );
}
