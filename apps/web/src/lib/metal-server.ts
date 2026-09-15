import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";
import { createMetalClient } from "@/lib/metal";
import { createClient } from "@/lib/supabase/server";

export const requireMetalSession = cache(async () => {
  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  if (!claimsData?.claims) {
    redirect("/login");
  }

  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) {
    redirect("/login");
  }

  return {
    claims: claimsData.claims,
    metal: createMetalClient(async () => accessToken),
  };
});
