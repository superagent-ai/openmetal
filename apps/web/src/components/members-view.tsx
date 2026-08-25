"use client";

import { useMemo, useState, type FormEvent } from "react";
import {
  Add01Icon,
  Delete02Icon,
  MoreHorizontalIcon,
  Search01Icon,
  UserMultiple02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { createMetalClient } from "@/lib/metal";
import { createClient } from "@/lib/supabase/client";

type OrganizationRole = "owner" | "admin" | "member";
type InvitationRole = "admin" | "member";

type Member = {
  user_id: string;
  email: string;
  role: OrganizationRole;
  created_at: string;
};

type Invitation = {
  id: string;
  organization_id: string;
  email: string;
  role: InvitationRole;
  invited_by: string;
  created_at: string;
  expires_at: string;
  status: "pending" | "expired";
};

type TableRowItem =
  | { kind: "member"; key: string; email: string; role: OrganizationRole; member: Member }
  | {
      kind: "invitation";
      key: string;
      email: string;
      role: InvitationRole;
      invitation: Invitation;
    };

const dateFormatter = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatDate(value: string): string {
  return dateFormatter.format(new Date(value));
}

function roleLabel(role: OrganizationRole): string {
  if (role === "owner") return "Owner";
  if (role === "admin") return "Admin";
  return "Member";
}

export function MembersView({
  organizationId,
  organizationName,
  viewerUserId,
  viewerRole,
  initialMembers,
  initialInvitations,
}: {
  organizationId: string;
  organizationName: string;
  viewerUserId: string;
  viewerRole: OrganizationRole;
  initialMembers: Member[];
  initialInvitations: Invitation[];
}) {
  const supabase = useMemo(() => createClient(), []);
  const metal = useMemo(
    () =>
      createMetalClient(async () => {
        const { data } = await supabase.auth.getSession();
        return data.session?.access_token;
      }),
    [supabase],
  );
  const canManage = viewerRole === "owner" || viewerRole === "admin";
  const [members, setMembers] = useState(initialMembers);
  const [invitations, setInvitations] = useState(initialInvitations);
  const [query, setQuery] = useState("");
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InvitationRole>("member");
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string>();
  const [removingMember, setRemovingMember] = useState<Member>();
  const [revokingInvitation, setRevokingInvitation] = useState<Invitation>();
  const [isMutating, setIsMutating] = useState(false);
  const [mutateError, setMutateError] = useState<string>();
  const [updatingKey, setUpdatingKey] = useState<string>();
  const [roleError, setRoleError] = useState<string>();

  const ownerCount = members.filter((member) => member.role === "owner").length;

  const rows = useMemo<TableRowItem[]>(() => {
    const memberRows: TableRowItem[] = members.map((member) => ({
      kind: "member",
      key: `member:${member.user_id}`,
      email: member.email,
      role: member.role,
      member,
    }));
    const invitationRows: TableRowItem[] = invitations.map((invitation) => ({
      kind: "invitation",
      key: `invitation:${invitation.id}`,
      email: invitation.email,
      role: invitation.role,
      invitation,
    }));
    return [...memberRows, ...invitationRows];
  }, [invitations, members]);

  const filteredRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return rows;
    }
    return rows.filter((row) => {
      const status = row.kind === "member" ? "active" : row.invitation.status;
      return (
        row.email.toLowerCase().includes(needle) ||
        row.role.toLowerCase().includes(needle) ||
        status.includes(needle)
      );
    });
  }, [query, rows]);

  function resetCreateDialog() {
    setEmail("");
    setRole("member");
    setCreateError(undefined);
    setIsCreating(false);
  }

  async function refreshMembers() {
    const result = await metal.members.list(organizationId);
    setMembers(result.members);
    setInvitations(result.invitations);
  }

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    setIsCreating(true);
    setCreateError(undefined);
    try {
      await metal.invitations.create(organizationId, { email, role });
      await refreshMembers();
      setIsCreateOpen(false);
      resetCreateDialog();
    } catch (caught) {
      setCreateError(caught instanceof Error ? caught.message : "Could not send the invitation");
      setIsCreating(false);
    }
  }

  async function handleRemoveMember() {
    if (!removingMember) {
      return;
    }
    setIsMutating(true);
    setMutateError(undefined);
    try {
      await metal.members.remove(organizationId, removingMember.user_id);
      await refreshMembers();
      setRemovingMember(undefined);
    } catch (caught) {
      setMutateError(caught instanceof Error ? caught.message : "Could not remove the member");
    } finally {
      setIsMutating(false);
    }
  }

  async function handleRevokeInvitation() {
    if (!revokingInvitation) {
      return;
    }
    setIsMutating(true);
    setMutateError(undefined);
    try {
      await metal.invitations.revoke(organizationId, revokingInvitation.id);
      await refreshMembers();
      setRevokingInvitation(undefined);
    } catch (caught) {
      setMutateError(caught instanceof Error ? caught.message : "Could not revoke the invitation");
    } finally {
      setIsMutating(false);
    }
  }

  async function handleUpdateMemberRole(member: Member, role: InvitationRole) {
    if (member.role === role) {
      return;
    }
    const key = `member:${member.user_id}`;
    setUpdatingKey(key);
    setRoleError(undefined);
    try {
      const updated = await metal.members.update(organizationId, member.user_id, { role });
      setMembers((current) =>
        current.map((item) => (item.user_id === updated.user_id ? updated : item)),
      );
    } catch (caught) {
      setRoleError(caught instanceof Error ? caught.message : "Could not update the role");
    } finally {
      setUpdatingKey(undefined);
    }
  }

  async function handleUpdateInvitationRole(invitation: Invitation, role: InvitationRole) {
    if (invitation.role === role) {
      return;
    }
    const key = `invitation:${invitation.id}`;
    setUpdatingKey(key);
    setRoleError(undefined);
    try {
      const updated = await metal.invitations.update(organizationId, invitation.id, { role });
      setInvitations((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    } catch (caught) {
      setRoleError(caught instanceof Error ? caught.message : "Could not update the role");
    } finally {
      setUpdatingKey(undefined);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-balance">Members</h1>
        <p className="mt-1 text-sm text-muted-foreground text-pretty">
          Invite people to {organizationName} and manage their access.
        </p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-sm">
          <HugeiconsIcon
            icon={Search01Icon}
            strokeWidth={2}
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search members…"
            aria-label="Search members"
            className="pl-8"
          />
        </div>
        {canManage ? (
          <Button type="button" onClick={() => setIsCreateOpen(true)}>
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
            Add new
          </Button>
        ) : null}
      </div>

      {roleError ? (
        <Alert variant="destructive">
          <AlertDescription>{roleError}</AlertDescription>
        </Alert>
      ) : null}

      <div className="overflow-hidden rounded-xl border">
        <Table>
          <TableHeader className="bg-muted">
            <TableRow>
              <TableHead className="pl-4">Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Joined</TableHead>
              <TableHead className="w-16 pr-4 text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredRows.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="h-56 whitespace-normal text-center">
                  <div className="mx-auto flex max-w-sm flex-col items-center gap-3">
                    <div className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                      <HugeiconsIcon icon={UserMultiple02Icon} strokeWidth={2} className="size-5" />
                    </div>
                    <div>
                      <p className="font-medium">
                        {rows.length === 0 ? "No members yet" : "No matching members"}
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground text-pretty">
                        {rows.length === 0
                          ? `Invite teammates to ${organizationName}.`
                          : "Try a different search."}
                      </p>
                    </div>
                    {canManage && rows.length === 0 ? (
                      <Button type="button" variant="outline" onClick={() => setIsCreateOpen(true)}>
                        Add new
                      </Button>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              filteredRows.map((row) => {
                const status =
                  row.kind === "member"
                    ? "Active"
                    : row.invitation.status === "expired"
                      ? "Expired"
                      : "Pending";
                const joined =
                  row.kind === "member"
                    ? formatDate(row.member.created_at)
                    : formatDate(row.invitation.created_at);
                const canRemoveMember =
                  canManage &&
                  row.kind === "member" &&
                  !(row.member.role === "owner" && ownerCount <= 1);
                const canRevoke = canManage && row.kind === "invitation";
                const canChangeMemberRole =
                  canManage &&
                  row.kind === "member" &&
                  row.member.role !== "owner" &&
                  row.member.user_id !== viewerUserId;
                const canChangeInvitationRole = canManage && row.kind === "invitation";
                const canChangeRole = canChangeMemberRole || canChangeInvitationRole;
                const showActions = canChangeRole || canRemoveMember || canRevoke;
                const isUpdating = updatingKey === row.key;
                return (
                  <TableRow key={row.key}>
                    <TableCell className="pl-4 font-medium">{row.email}</TableCell>
                    <TableCell>{roleLabel(row.role)}</TableCell>
                    <TableCell>
                      <Badge variant={status === "Active" ? "secondary" : "outline"}>
                        {status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{joined}</TableCell>
                    <TableCell className="pr-4 text-right">
                      {showActions ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`Open actions for ${row.email}`}
                                disabled={isUpdating}
                              />
                            }
                          >
                            <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {canChangeRole ? (
                              <>
                                <DropdownMenuItem
                                  disabled={isUpdating || row.role === "member"}
                                  onClick={() => {
                                    if (row.kind === "member") {
                                      void handleUpdateMemberRole(row.member, "member");
                                    } else {
                                      void handleUpdateInvitationRole(row.invitation, "member");
                                    }
                                  }}
                                >
                                  Make member
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  disabled={isUpdating || row.role === "admin"}
                                  onClick={() => {
                                    if (row.kind === "member") {
                                      void handleUpdateMemberRole(row.member, "admin");
                                    } else {
                                      void handleUpdateInvitationRole(row.invitation, "admin");
                                    }
                                  }}
                                >
                                  Make admin
                                </DropdownMenuItem>
                                {canRemoveMember || canRevoke ? <DropdownMenuSeparator /> : null}
                              </>
                            ) : null}
                            {canRemoveMember ? (
                              <DropdownMenuItem
                                variant="destructive"
                                onClick={() => setRemovingMember(row.member)}
                              >
                                <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                                Remove
                              </DropdownMenuItem>
                            ) : null}
                            {canRevoke ? (
                              <DropdownMenuItem
                                variant="destructive"
                                onClick={() => setRevokingInvitation(row.invitation)}
                              >
                                <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                                Revoke invite
                              </DropdownMenuItem>
                            ) : null}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog
        open={isCreateOpen}
        onOpenChange={(open) => {
          setIsCreateOpen(open);
          if (!open) {
            resetCreateDialog();
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <form onSubmit={handleCreate} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Invite member</DialogTitle>
              <DialogDescription>
                Send an invitation to join {organizationName}. They will get access only to this
                organization.
              </DialogDescription>
            </DialogHeader>
            {createError ? (
              <Alert variant="destructive">
                <AlertDescription>{createError}</AlertDescription>
              </Alert>
            ) : null}
            <div className="grid gap-2">
              <Label htmlFor="invite-email">Email</Label>
              <Input
                id="invite-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="teammate@company.com"
                maxLength={320}
                autoFocus
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="invite-role">Role</Label>
              <Select
                value={role}
                onValueChange={(value) => setRole((value as InvitationRole | null) ?? "member")}
              >
                <SelectTrigger id="invite-role" className="w-full">
                  <SelectValue>{roleLabel(role)}</SelectValue>
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  <SelectItem value="member">Member</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
              <Button type="submit" disabled={isCreating}>
                {isCreating ? "Sending" : "Send invite"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {removingMember ? (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setRemovingMember(undefined);
              setMutateError(undefined);
            }
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogMedia>
                <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
              </AlertDialogMedia>
              <AlertDialogTitle>Remove {removingMember.email}?</AlertDialogTitle>
              <AlertDialogDescription>
                They will lose access to {organizationName} immediately.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {mutateError ? (
              <Alert variant="destructive">
                <AlertDescription>{mutateError}</AlertDescription>
              </Alert>
            ) : null}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={isMutating}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={isMutating}
                onClick={() => void handleRemoveMember()}
              >
                {isMutating ? "Removing" : "Remove"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}

      {revokingInvitation ? (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setRevokingInvitation(undefined);
              setMutateError(undefined);
            }
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogMedia>
                <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
              </AlertDialogMedia>
              <AlertDialogTitle>Revoke invite for {revokingInvitation.email}?</AlertDialogTitle>
              <AlertDialogDescription>
                The pending invitation to {organizationName} will no longer be valid.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {mutateError ? (
              <Alert variant="destructive">
                <AlertDescription>{mutateError}</AlertDescription>
              </Alert>
            ) : null}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={isMutating}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={isMutating}
                onClick={() => void handleRevokeInvitation()}
              >
                {isMutating ? "Revoking" : "Revoke"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </div>
  );
}
