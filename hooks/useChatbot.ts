
"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { PROMPTS } from "@/lib/prompts";
import { ChatbotActions, ChatbotState, Message, Prompt } from "@/types";

interface GeminiContent {
  role: string;
  parts: { text: string }[];
}


const getInitialSelectedPrompt = (
  cookiePromptId: string | undefined
): Prompt => {
  if (cookiePromptId) {
    const promptFromCookie = PROMPTS.find((p) => p.id === cookiePromptId);
    if (promptFromCookie) {
      console.log(
        "[useChatbot] Initializing selectedPrompt from cookie:",
        promptFromCookie.name
      );
      return promptFromCookie;
    }
    console.warn(
      `[useChatbot] Prompt ID "${cookiePromptId}" from cookie not found. Falling back to default.`
    );
  }

  if (PROMPTS.length > 0) {
    console.log(
      "[useChatbot] Initializing selectedPrompt with default:",
      PROMPTS[0].name
    );
    return PROMPTS[0];
  }

  console.error(
    "[useChatbot] PROMPTS array is empty. Cannot select an initial prompt."
  );

  return {
    id: "error_no_prompts",
    name: "Error",
    text: "No prompts configured.",
    greeting: "Error: Chatbot cannot be initialized without prompts.",
  };
};

export function useChatbot(
  initialPromptIdFromCookie: string | undefined
): ChatbotState & ChatbotActions {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);


  const [selectedPrompt, setSelectedPrompt] = useState<Prompt>(() =>
    getInitialSelectedPrompt(initialPromptIdFromCookie)
  );

  const messageIdCounter = useRef(0);

  const generateMessageId = useCallback(() => {
    return `msg_${Date.now()}_${++messageIdCounter.current}`;
  }, []);

  const initializeChat = useCallback(
    (promptToInit: Prompt, existingMessages?: Message[]) => {
      setIsLoading(true);
      setError(null);
      try {
        console.log(
          "[useChatbot] Initializing/Updating chat with prompt:",
          promptToInit.name,
          "Existing messages count:",
          existingMessages?.length || 0
        );

        if (!existingMessages || existingMessages.length === 0) {
          const greetingMessage: Message = {
            id: generateMessageId(),
            sender: "ai",
            text: promptToInit.greeting,
            timestamp: new Date(),
          };
          setMessages([greetingMessage]);
        } else {
          setMessages([...existingMessages]);
        }
        console.log("[useChatbot] Chat initialized/updated successfully.");
      } catch (err) {
        console.error("[useChatbot] Failed to initialize/update chat:", err);
        const errorMsg = err instanceof Error ? err.message : String(err);
        setError(`Failed to initialize/update chat: ${errorMsg}`);
        if (!existingMessages || existingMessages.length === 0) {
          setMessages([]);
        }
      } finally {
        setIsLoading(false);
      }
    },
    [generateMessageId]
  );

  useEffect(() => {
    if (selectedPrompt && selectedPrompt.id !== "error_no_prompts") {
      if (messages.length === 0) {
        console.log(
          `[useChatbot] useEffect [selectedPrompt]: Initializing chat for prompt "${selectedPrompt.name}".`
        );
        initializeChat(selectedPrompt);
      }
    }
  }, [selectedPrompt, initializeChat, messages.length]); 


  const sendMessage = useCallback(
    async (messageText: string) => {
      if (!messageText.trim() || isLoading) return;

      const userMessage: Message = {
        id: generateMessageId(),
        sender: "user",
        text: messageText.trim(),
        timestamp: new Date(),
      };
      
      const currentMessages = [...messages]; 

      setMessages((prev) => [...prev, userMessage]);
      setIsLoading(true);
      setError(null);

      const aiMessageId = generateMessageId();
      const initialAiMessage: Message = {
        id: aiMessageId,
        sender: "ai",
        text: "",
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, initialAiMessage]);

      let historyForGemini: GeminiContent[] = [];
      let firstUserMessageIndex = currentMessages.findIndex(
        (msg) => msg.sender === "user"
      );

      if (firstUserMessageIndex !== -1) {
        const relevantMessages = currentMessages.slice(firstUserMessageIndex);
        const mappedHistory = relevantMessages.map((message) => ({
          parts: [{ text: message.text }],
          role: message.sender === "user" ? "user" : "model",
        }));

        let currentExpectedRole = "user";
        for (const msg of mappedHistory) {
          if (
            msg.role === "model" &&
            (msg.parts[0].text.trim() === "" ||
              msg.parts[0].text.trim() === selectedPrompt.greeting ||
              msg.parts[0].text.startsWith("Sorry, an error occurred"))
          ) {
            console.log(
              "[useChatbot] Skipping empty/greeting/error AI message from history construction:",
              msg.parts[0].text.substring(0, 30)
            );
            continue;
          }

          if (msg.role === currentExpectedRole) {
            historyForGemini.push(msg);
            currentExpectedRole =
              currentExpectedRole === "user" ? "model" : "user";
          } else {
            console.warn(
              `[useChatbot] History role mismatch. Expected ${currentExpectedRole}, got ${msg.role}. Truncating history here.`
            );
            break;
          }
        }
      }

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            history: historyForGemini,
            message: messageText.trim(),
            systemInstruction: selectedPrompt.text.trim(),
          }),
        });

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(errText || `Server error: ${response.status}`);
        }

        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error("No response body to stream from");
        }

        const decoder = new TextDecoder();
        let accumulatedText = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunkText = decoder.decode(value, { stream: true });
          accumulatedText += chunkText;
          setMessages((prevMessages) =>
            prevMessages.map((msg) =>
              msg.id === aiMessageId ? { ...msg, text: accumulatedText } : msg
            )
          );
        }

        const remainingText = decoder.decode();
        if (remainingText) {
          accumulatedText += remainingText;
          setMessages((prevMessages) =>
            prevMessages.map((msg) =>
              msg.id === aiMessageId ? { ...msg, text: accumulatedText } : msg
            )
          );
        }
      } catch (err) {
        console.error("[useChatbot] Error sending message:", err);
        const errorMessageText =
          err instanceof Error ? err.message : "Unknown error sending message";
        setError(`Failed to get response: ${errorMessageText}`);
        setMessages((prevMessages) =>
          prevMessages.map((msg) =>
            msg.id === aiMessageId
              ? {
                  ...msg,
                  text: `Sorry, an error occurred: ${errorMessageText}. Please try again.`,
                }
              : msg
          )
        );
      } finally {
        setIsLoading(false);
      }
    },
    [
      isLoading,
      generateMessageId,
      selectedPrompt,
      messages,
    ]
  );

  const changePrompt = useCallback(
    (promptId: string) => {
      const newPrompt = PROMPTS.find((p) => p.id === promptId);
      if (!newPrompt) {
        console.error(`[useChatbot] Prompt with id ${promptId} not found`);
        setError(`Prompt with id ${promptId} not found. Using current prompt.`);
        return;
      }
      if (newPrompt.id === selectedPrompt.id) {
        console.log("[useChatbot] Prompt already selected:", newPrompt.name);
        return;
      }

      console.log("[useChatbot] Changing prompt to:", newPrompt.name);
      setSelectedPrompt(newPrompt);

      initializeChat(newPrompt, messages);
    },
    [initializeChat, messages, selectedPrompt.id] 
  );

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const resetChat = useCallback(() => {
    console.log("[useChatbot] Resetting chat with prompt:", selectedPrompt.name);
    setMessages([]); 
    initializeChat(selectedPrompt);
  }, [selectedPrompt, initializeChat]);

  return {
    messages,
    isLoading,
    error,
    selectedPrompt,
    sendMessage,
    changePrompt,
    clearError,
    resetChat,
  };
}