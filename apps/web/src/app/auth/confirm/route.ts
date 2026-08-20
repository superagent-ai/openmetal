import { type EmailOtpType } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { safeInternalPath } from "@/lib/safe-redirect";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const requestedType = searchParams.get("type") as EmailOtpType | null;
  const next = safeInternalPath(searchParams.get("next"), "/dashboard");
  const redirectTo = NextResponse.redirect(new URL(next, origin));
  const failed = NextResponse.redirect(new URL("/login?error=Confirmation%20failed", origin));

  if (!tokenHash) {
    return failed;
  }

  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookieOptions: {
        path: "/",
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
      },
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          cookiesToSet.forEach(({ name, value, options }) => {
            try {
              cookieStore.set(name, value, options);
            } catch {
              // Route handlers still persist cookies on the redirect response.
            }
            redirectTo.cookies.set(name, value, options);
            failed.cookies.set(name, value, options);
          });
          if (headers) {
            Object.entries(headers).forEach(([key, value]) => {
              redirectTo.headers.set(key, value);
              failed.headers.set(key, value);
            });
          }
        },
      },
    },
  );

  const types = Array.from(
    new Set([requestedType, "email", "magiclink"].filter(Boolean) as EmailOtpType[]),
  );
  for (const type of types) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) {
      return redirectTo;
    }
  }

  return failed;
}
