import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { loginErrorPath, postAuthPath } from "@/lib/auth-redirect";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = postAuthPath(searchParams.get("next"));
  const oauthError = searchParams.get("error_description") ?? searchParams.get("error");
  const redirectTo = NextResponse.redirect(new URL(next, origin));
  const failed = NextResponse.redirect(
    new URL(loginErrorPath(oauthError ?? "Sign in failed", next), origin),
  );

  if (!code) {
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

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (!error) {
    return redirectTo;
  }

  return NextResponse.redirect(new URL(loginErrorPath(error.message, next), origin));
}
