"use strict";

(() => {
  if (!window.sovereignbot?.conversations || typeof openDirect !== "function") return;

  const baseOpenDirectCoworker = openDirect;
  const baseRefreshConversation = refreshConversation;
  const baseRenderConversationHeader = renderConversationHeader;

  function chief() {
    return state.coworkers.find((coworker) =>
      coworker.state === "active" && (
        coworker.name.trim().toLowerCase() === "chief of staff" ||
        /coordinate specialists|chief of staff/i.test(`${coworker.role || ""} ${coworker.instructions || ""}`)
      )
    );
  }

  function isChiefRoom(conversation) {
    const lead = chief();
    return Boolean(lead && conversation?.kind === "team" && conversation.title === "Chief of Staff" && conversation.participants?.includes(lead.id));
  }

  function pinChiefRecipient() {
    const conversation = state.selectedConversation;
    const lead = chief();
    if (!lead || !isChiefRoom(conversation)) return;
    if (!state.mentionIds.size) {
      state.mentionIds.add(lead.id);
      renderMentions();
    }
  }

  openDirect = async function openChiefAwareCoworker(coworkerId) {
    const target = state.coworkers.find((entry) => entry.id === coworkerId);
    const lead = chief();
    if (!target || !lead || target.id !== lead.id)
      return baseOpenDirectCoworker(coworkerId);

    const activeIds = state.coworkers.filter((entry) => entry.state === "active").slice(0, 7).map((entry) => entry.id);
    if (activeIds.length < 2)
      return baseOpenDirectCoworker(coworkerId);

    let conversation = state.conversations.find((entry) => isChiefRoom(entry));
    if (!conversation) {
      conversation = await window.sovereignbot.conversations.createTeam({
        title: "Chief of Staff",
        coworkerIds: activeIds,
        leadCoworkerId: lead.id,
      });
      await refreshConversations();
    }
    await openConversation(conversation.id);
    pinChiefRecipient();
  };

  refreshConversation = async function refreshChiefAwareConversation(...args) {
    const result = await baseRefreshConversation(...args);
    pinChiefRecipient();
    return result;
  };

  renderConversationHeader = function renderChiefHeader(conversation) {
    baseRenderConversationHeader(conversation);
    if (!isChiefRoom(conversation)) return;
    $("conversation-kind").textContent = "Chief-led";
    $("conversation-subtitle").textContent = "Tell Chief the outcome. Chief routes the work to your team.";
  };
})();
