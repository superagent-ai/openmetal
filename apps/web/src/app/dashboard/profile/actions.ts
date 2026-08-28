"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireMetalSession } from "@/lib/metal-server";
import { createClient } from "@/lib/supabase/server";

const UpdateProfileSchema = z.object({
  displayName: z
    .string()
    .trim()
    .min(1, "Enter a display name")
    .max(80, "Use 80 characters or fewer"),
});

export type UpdateProfileState = {
  status?: "success" | "error";
  message?: string;
  fieldError?: string;
};

export async function updateProfile(
  _previousState: UpdateProfileState,
  formData: FormData,
): Promise<UpdateProfileState> {
  const parsed = UpdateProfileSchema.safeParse({
    displayName: formData.get("displayName"),
  });

  if (!parsed.success) {
    return {
      status: "error",
      fieldError: parsed.error.issues[0]?.message ?? "Enter a valid display name",
    };
  }

  await requireMetalSession();
  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({
    data: { display_name: parsed.data.displayName },
  });

  if (error) {
    return {
      status: "error",
      message: "Could not update your profile. Please try again.",
    };
  }

  revalidatePath("/dashboard", "layout");
  return {
    status: "success",
    message: "Profile updated.",
  };
}
